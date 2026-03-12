import { GoogleGenerativeAI } from '@google/generative-ai';
import { supabaseAdmin } from '../supabaseClient';
import sharp from 'sharp';
import type { Metadata } from 'sharp';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import {
    PdfStructuralExtractor,
    StructuralPageAnalysis,
    StructuralPdfPage,
    isNativeImageViable,
} from './pdf-structural-extractor';
import { processStoreImage, StoreImagePipelineResult } from './store-image-pipeline';

interface ExtractedProduct {
    product_name: string;
    ref_id: string;
    price: number;
    box_2d: [number, number, number, number];
    ean?: string;
    ncm?: string;
    unit?: string;
    category?: string;
    master_pack?: string;
}

interface PreparedCatalogImage {
    image: StoreImagePipelineResult;
    sourceStrategy: 'native' | 'render_450' | 'render_600' | 'vision_fallback';
    nativeWidth?: number;
    nativeHeight?: number;
    renderDpi?: number;
    bbox?: {
        ymin: number;
        xmin: number;
        ymax: number;
        xmax: number;
    };
}

export class PdfExtractionService {
    private genAI: GoogleGenerativeAI;
    private structuralExtractor: PdfStructuralExtractor;

    constructor() {
        const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
        if (!apiKey) throw new Error('GOOGLE_GENERATIVE_AI_API_KEY is required');
        this.genAI = new GoogleGenerativeAI(apiKey);
        this.structuralExtractor = new PdfStructuralExtractor();
    }

    /**
     * Gera um Hash SHA-256 do conteúdo do arquivo para identificação única
     */
    async calculateFileHash(filePath: string): Promise<string> {
        return new Promise((resolve, reject) => {
            const hash = crypto.createHash('sha256');
            const stream = fs.createReadStream(filePath);
            stream.on('data', (data) => hash.update(data));
            stream.on('end', () => resolve(hash.digest('hex')));
            stream.on('error', (err) => reject(err));
        });
    }

    /**
     * Verifica se o catálogo (pelo hash) já foi processado
     */
    async isCatalogProcessed(fileHash: string): Promise<boolean> {
        if (!supabaseAdmin) return false;
        const { data } = await supabaseAdmin
            .from('processed_catalogs')
            .select('id')
            .eq('file_hash', fileHash)
            .maybeSingle();
        return !!data;
    }

    /**
     * Marca o catálogo como processado no banco de dados
     */
    async markCatalogAsProcessed(fileName: string, fileHash: string, totalPages: number) {
        if (!supabaseAdmin) return;
        await supabaseAdmin.from('processed_catalogs').insert({
            file_name: fileName,
            file_hash: fileHash,
            total_pages: totalPages,
        });
    }

    /**
     * Detecta o total de páginas de um PDF usando pdfinfo
     */
    async getNumPages(pdfPath: string): Promise<number> {
        return new Promise((resolve) => {
            const proc = spawn('pdfinfo', [pdfPath]);
            let stdout = '';
            proc.stdout.on('data', (data) => {
                stdout += data.toString();
            });
            proc.on('close', () => {
                const match = stdout.match(/Pages:\s+(\d+)/);
                resolve(match ? Number.parseInt(match[1], 10) : 1);
            });
        });
    }

    /**
     * Gera um Perceptual Hash (dHash) simples de 64 bits para deduplicação visual
     */
    async calculatePHash(buffer: Buffer): Promise<string> {
        try {
            const { data } = await sharp(buffer)
                .grayscale()
                .resize(9, 8, { fit: 'fill' })
                .raw()
                .toBuffer({ resolveWithObject: true });

            let hash = '';
            for (let row = 0; row < 8; row++) {
                for (let col = 0; col < 8; col++) {
                    const left = data[row * 9 + col];
                    const right = data[row * 9 + col + 1];
                    hash += left < right ? '1' : '0';
                }
            }
            return BigInt(`0b${hash}`).toString(16).padStart(16, '0');
        } catch {
            return '0000000000000000';
        }
    }

    /**
     * Envia a imagem da página para o Gemini extrair produtos com o motor exaustivo
     */
    async extractProductsFromImageBuffer(imageBuffer: Buffer): Promise<ExtractedProduct[]> {
        const model = this.genAI.getGenerativeModel({ model: 'gemini-flash-latest' });

        const imagePart = {
            inlineData: {
                data: imageBuffer.toString('base64'),
                mimeType: 'image/png',
            },
        };

        const prompt = `Você é um especialista em extração visual de dados focado em catálogos técnicos. Sua tarefa é analisar esta página e extrair TODOS os produtos com precisão cirúrgica.

REGRAS DE OURO:
1. NCM (ALTA PRIORIDADE): Localize o NCM (ex: 8302.20.00).
2. MASTER PACK (NOVA): Localize informações de caixa master, como "C. MASTER: 12", "CX: 60" ou "PCS/CX: 40". Extraia apenas o número.
3. CÓDIGO FORNECEDOR: Localize o "ITEM NO." ou códigos de fábrica.
4. EAN: Localize códigos de 13 dígitos numéricos.
5. PREÇO UNITÁRIO: Valor para 1 unidade.
6. DESCRIÇÃO: Nome técnico completo.
7. BOUNDING BOX (box_2d) CRÍTICO: O array [ymin, xmin, ymax, xmax] DEVE envolver ESTREITAMENTE APENAS A FOTO/IMAGEM do produto. DEIXE DE FORA TODO E QUALQUER TEXTO, títulos, códigos, preços, ou letras ao redor da imagem ou abaixo dela. A caixa não pode englobar textos.

SAÍDA:
Retorne EXCLUSIVAMENTE um array JSON puro. Não retorne conversação, saudações ou explicações textuais em hipótese alguma. Se não houver produtos, retorne []. O campo "master_pack" deve conter apenas o número da caixa master. O campo "ref_id" deve conter o Código do Fornecedor.

Exemplo: [{"product_name": "Nome", "ref_id": "QH-3921", "ncm": "8302.20.00", "price": 4.73, "master_pack": "12", "unit": "UN", "box_2d": [0,0,0,0]}]`;

        console.log('[Gemini] Analisando página (Vision Engine)...');

        let retries = 3;
        while (retries > 0) {
            try {
                await new Promise((res) => setTimeout(res, 4000));
                const result = await model.generateContent([prompt, imagePart]);
                const response = await result.response;
                let text = response.text().replace(/```json|```/g, '').trim();

                if (!text.startsWith('[')) {
                    const match = text.match(/\[[\s\S]*\]/);
                    if (match) {
                        text = match[0];
                    } else {
                        console.warn('[Gemini] Resposta fora do padrão. Retornando vazio.', text);
                        return [];
                    }
                }

                return JSON.parse(text);
            } catch (error: any) {
                if (error.status === 429) {
                    console.warn('⚠️ Rate limit atingido. Aguardando 30 segundos...');
                    await new Promise((res) => setTimeout(res, 30000));
                    retries--;
                } else {
                    throw error;
                }
            }
        }

        return [];
    }

    async renderPageToBuffer(pdfPath: string, pageNumber: number, dpi: number): Promise<Buffer> {
        const pdfBuffer = await fs.promises.readFile(pdfPath);

        return new Promise((resolve, reject) => {
            const proc = spawn('pdftoppm', [
                '-f',
                pageNumber.toString(),
                '-l',
                pageNumber.toString(),
                '-png',
                '-r',
                dpi.toString(),
                '-singlefile',
                '-',
            ]);

            const chunks: Buffer[] = [];
            let stderr = '';

            proc.stdin.write(pdfBuffer);
            proc.stdin.end();

            proc.stdout.on('data', (data) => {
                chunks.push(Buffer.from(data));
            });

            proc.stderr.on('data', (data) => {
                stderr += data.toString();
            });

            proc.on('close', (code) => {
                if (code !== 0) {
                    reject(new Error(`pdftoppm falhou na página ${pageNumber} (${dpi} DPI): ${stderr}`));
                    return;
                }

                resolve(Buffer.concat(chunks));
            });
        });
    }

    async prepareNativeImage(page: StructuralPdfPage, analysis: StructuralPageAnalysis): Promise<Map<string, PreparedCatalogImage>> {
        const prepared = new Map<string, PreparedCatalogImage>();

        for (const association of analysis.associations) {
            const refId = String(association.refId || '').trim();
            if (!refId) continue;
            if (!association.image.buffer || !isNativeImageViable(association.image)) continue;

            const image = await processStoreImage(association.image.buffer);
            prepared.set(refId, {
                image,
                sourceStrategy: 'native',
                nativeWidth: association.image.nativeWidth,
                nativeHeight: association.image.nativeHeight,
            });

            this.logItem({
                ref: refId,
                page: page.pageNumber,
                sourceStrategy: 'native',
                nativeWidth: association.image.nativeWidth,
                nativeHeight: association.image.nativeHeight,
                finalWidth: image.width,
                finalHeight: image.height,
            });
        }

        return prepared;
    }

    private clampCropBox(
        metadata: Metadata,
        box: [number, number, number, number]
    ): { left: number; top: number; width: number; height: number; ymin: number; xmin: number; ymax: number; xmax: number } | null {
        const pageWidth = metadata.width ?? 0;
        const pageHeight = metadata.height ?? 0;
        if (!pageWidth || !pageHeight) return null;

        const ymin = Math.max(0, Math.min(1000, box[0]));
        const xmin = Math.max(0, Math.min(1000, box[1]));
        const ymax = Math.max(0, Math.min(1000, box[2]));
        const xmax = Math.max(0, Math.min(1000, box[3]));

        const left = Math.max(0, Math.floor((Math.min(xmin, xmax) / 1000) * pageWidth));
        const top = Math.max(0, Math.floor((Math.min(ymin, ymax) / 1000) * pageHeight));
        const width = Math.max(10, Math.min(pageWidth - left, Math.ceil((Math.abs(xmax - xmin) / 1000) * pageWidth)));
        const height = Math.max(10, Math.min(pageHeight - top, Math.ceil((Math.abs(ymax - ymin) / 1000) * pageHeight)));

        if (width <= 0 || height <= 0) return null;

        return { left, top, width, height, ymin, xmin, ymax, xmax };
    }

    private isSmallFinalResult(width: number, height: number): boolean {
        const longSide = Math.max(width, height);
        const shortSide = Math.min(width, height);
        return longSide < 650 || shortSide < 320 || width * height < 180_000;
    }

    async prepareRenderedFallbackImage(
        renderedPageBuffer: Buffer,
        extracted: ExtractedProduct,
        renderDpi: number
    ): Promise<PreparedCatalogImage | null> {
        if (!Array.isArray(extracted.box_2d)) return null;

        const metadata = await sharp(renderedPageBuffer).metadata();
        const crop = this.clampCropBox(metadata, extracted.box_2d);
        if (!crop) return null;

        const croppedBuffer = await sharp(renderedPageBuffer)
            .extract({
                left: crop.left,
                top: crop.top,
                width: crop.width,
                height: crop.height,
            })
            .toBuffer();

        const image = await processStoreImage(croppedBuffer);
        return {
            image,
            sourceStrategy: renderDpi === 600 ? 'render_600' : 'render_450',
            renderDpi,
            bbox: {
                ymin: crop.ymin,
                xmin: crop.xmin,
                ymax: crop.ymax,
                xmax: crop.xmax,
            },
        };
    }

    private logItem(item: {
        ref: string;
        page: number;
        sourceStrategy: string;
        nativeWidth?: number;
        nativeHeight?: number;
        finalWidth?: number;
        finalHeight?: number;
        renderDpi?: number;
    }) {
        console.log(
            [
                '[BANK][ITEM]',
                `ref=${item.ref}`,
                `page=${item.page}`,
                `strategy=${item.sourceStrategy}`,
                `native=${item.nativeWidth ?? '-'}x${item.nativeHeight ?? '-'}`,
                `final=${item.finalWidth ?? '-'}x${item.finalHeight ?? '-'}`,
                `render_dpi=${item.renderDpi ?? '-'}`,
            ].join(' ')
        );
    }

    /**
     * Salva imagem já preparada na catalog_images_bank
     */
    async processProductToBank(
        prepared: PreparedCatalogImage,
        extracted: ExtractedProduct,
        pdfName: string,
        pageNum: number
    ) {
        if (!supabaseAdmin) return null;

        try {
            const phash = await this.calculatePHash(prepared.image.buffer);
            const safeRef = (extracted.ref_id || 'unkn').replace(/[^a-z0-9]/gi, '_');
            const fileName = `${safeRef}_${Date.now()}.webp`;

            const { error: uploadError } = await supabaseAdmin.storage
                .from('products')
                .upload(fileName, prepared.image.buffer, { contentType: 'image/webp', upsert: true });

            if (uploadError) throw uploadError;

            const { data: { publicUrl } } = supabaseAdmin.storage.from('products').getPublicUrl(fileName);

            const auditPayload = {
                ...(prepared.bbox ?? {}),
                source_strategy: prepared.sourceStrategy,
                native_width: prepared.nativeWidth ?? null,
                native_height: prepared.nativeHeight ?? null,
                render_dpi: prepared.renderDpi ?? null,
                page_number: pageNum,
                final_width: prepared.image.width,
                final_height: prepared.image.height,
            };

            const { error: dbError } = await supabaseAdmin.from('catalog_images_bank').insert({
                image_url: publicUrl,
                phash,
                ref_id: extracted.ref_id,
                ean: extracted.ean,
                name: extracted.product_name,
                price: extracted.price,
                unit: extracted.unit,
                category: extracted.master_pack ? `MP:${extracted.master_pack}` : extracted.category,
                source_pdf: pdfName,
                page_number: pageNum,
                bbox_json: auditPayload,
                width: prepared.image.width,
                height: prepared.image.height,
                model_version: prepared.sourceStrategy === 'native' ? 'pdftohtml-native' : 'gemini-flash-latest',
            });

            if (dbError) {
                if (dbError.code === '23505') {
                    console.log('[BANK] Imagem duplicada detectada (pHash). Ignorando.');
                } else {
                    throw dbError;
                }
            }

            this.logItem({
                ref: extracted.ref_id,
                page: pageNum,
                sourceStrategy: prepared.sourceStrategy,
                nativeWidth: prepared.nativeWidth,
                nativeHeight: prepared.nativeHeight,
                finalWidth: prepared.image.width,
                finalHeight: prepared.image.height,
                renderDpi: prepared.renderDpi,
            });

            return publicUrl;
        } catch (err: any) {
            console.error(`[BANK] Erro ao processar ${extracted.product_name}:`, err.message);
            return null;
        }
    }

    /**
     * Orquestra a criação do Banco de Imagens
     */
    async processCatalogToBank(pdfPath: string, originalName: string, maxPages: number = 999, onProgress?: (msg: string) => void) {
        const fileHash = await this.calculateFileHash(pdfPath);

        const alreadyProcessed = await this.isCatalogProcessed(fileHash);
        if (alreadyProcessed) {
            onProgress?.('⏭️ [SKIP] Este catálogo já foi processado anteriormente. Ignorando para evitar duplicidade.');
            return true;
        }

        const totalPages = await this.getNumPages(pdfPath);
        const pagesToProcess = Math.min(totalPages, maxPages);
        let structuralPages: StructuralPdfPage[] = [];

        try {
            structuralPages = await this.structuralExtractor.extractFromPath(pdfPath);
        } catch (structuralError) {
            console.warn('[BANK][STRUCT] Structural extraction unavailable. Falling back to vision/render only.', structuralError);
        }

        const pdfName = path.basename(pdfPath);

        onProgress?.(`✅ Estrutura do PDF carregada. Processando ${pagesToProcess} páginas...`);

        for (let pageNumber = 1; pageNumber <= pagesToProcess; pageNumber++) {
            onProgress?.(`📄 Analisando página ${pageNumber}/${pagesToProcess}...`);

            try {
                const page = structuralPages.find((entry) => entry.pageNumber === pageNumber);
                const analysis = page ? this.structuralExtractor.analyzePage(page) : null;
                const handledRefs = new Set<string>();

                if (page && analysis?.isTabular) {
                    const nativePrepared = await this.prepareNativeImage(page, analysis);
                    for (const [refId, prepared] of nativePrepared.entries()) {
                        const matched = analysis.associations.find((association) => association.refId === refId);
                        const product_name = matched?.matchedTexts.map((text) => text.content).join(' ').slice(0, 255) || refId;
                        const saved = await this.processProductToBank(
                            prepared,
                            {
                                product_name,
                                ref_id: refId,
                                price: 0,
                                box_2d: [0, 0, 0, 0],
                            },
                            pdfName,
                            pageNumber
                        );

                        if (saved) {
                            handledRefs.add(refId);
                            onProgress?.(`✅ [native] ${refId}`);
                        }
                    }
                }

                const needsFallback =
                    !analysis
                    || !analysis.isTabular
                    || analysis.associations.length === 0
                    || analysis.unassignedImages > 0
                    || handledRefs.size < analysis.associations.length;

                if (!needsFallback) {
                    continue;
                }

                const rendered450 = await this.renderPageToBuffer(pdfPath, pageNumber, 450);
                const extracted = await this.extractProductsFromImageBuffer(rendered450);
                onProgress?.(`💎 Vision detectou ${extracted.length} itens na página ${pageNumber}.`);

                let rendered600: Buffer | null = null;

                for (const item of extracted) {
                    const refId = String(item.ref_id || '').trim();
                    if (!refId || handledRefs.has(refId)) continue;

                    let prepared = await this.prepareRenderedFallbackImage(rendered450, item, 450);

                    if (prepared && this.isSmallFinalResult(prepared.image.width, prepared.image.height)) {
                        rendered600 ??= await this.renderPageToBuffer(pdfPath, pageNumber, 600);
                        const retried = await this.prepareRenderedFallbackImage(rendered600, item, 600);
                        if (retried) {
                            prepared = retried;
                        }
                    }

                    if (!prepared) continue;

                    const url = await this.processProductToBank(prepared, item, pdfName, pageNumber);
                    if (url) {
                        handledRefs.add(refId);
                        onProgress?.(`✅ [${prepared.sourceStrategy}] ${item.product_name} (${refId})`);
                    }
                }
            } catch (err: any) {
                onProgress?.(`❌ Erro na página ${pageNumber}: ${err.message}`);
                console.error(err);
            }
        }

        await this.markCatalogAsProcessed(originalName, fileHash, pagesToProcess);
        return true;
    }
}
