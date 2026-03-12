import sharp from 'sharp';
import type { Metadata } from 'sharp';
import { spawn } from 'child_process';
import { GoogleGenerativeAI } from '@google/generative-ai';
import {
    PdfStructuralExtractor,
    StructuralPageAnalysis,
    StructuralPdfPage,
    isNativeImageViable,
} from '@/lib/services/pdf-structural-extractor';
import { processStoreImage } from '@/lib/services/store-image-pipeline';

// Initialize Gemini for Vision tasks
const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY || process.env.GOOGLE_SEARCH_API_KEY;
const genAI = apiKey ? new GoogleGenerativeAI(apiKey) : null;
const visionModel = genAI ? genAI.getGenerativeModel({ model: 'gemini-2.0-flash' }) : null;

export interface ExtractedImage {
    ean: string;
    buffer?: Buffer;
    page: number;
    sourceStrategy: 'native' | 'render_450' | 'render_600' | 'vision_fallback';
    nativeWidth?: number;
    nativeHeight?: number;
    renderDpi?: number;
    finalWidth?: number;
    finalHeight?: number;
}

interface VisionProduct {
    product_name?: string;
    ref_id?: string;
    box_2d?: [number, number, number, number];
}

interface ProcessedRenderCrop {
    buffer: Buffer;
    width: number;
    height: number;
    renderDpi: number;
}

/**
 * Gets the total number of pages in the PDF buffer using pdfinfo.
 */
async function getNumPages(pdfBuffer: Buffer): Promise<number> {
    return new Promise((resolve, reject) => {
        const process = spawn('pdfinfo', ['-']);
        let stdout = '';
        let stderr = '';

        process.stdin.write(pdfBuffer);
        process.stdin.end();

        process.stdout.on('data', (data) => {
            stdout += data.toString();
        });

        process.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        process.on('close', (code) => {
            if (code !== 0 && !stdout.includes('Pages:')) {
                return reject(new Error(`pdfinfo exited with code ${code}: ${stderr}`));
            }

            const match = stdout.match(/Pages:\s+(\d+)/);
            if (match?.[1]) {
                resolve(Number.parseInt(match[1], 10));
                return;
            }

            reject(new Error('Could not parse page count from pdfinfo output'));
        });
    });
}

/**
 * Renders a specific page of the PDF buffer to a PNG buffer using pdftoppm.
 */
async function renderPageToBuffer(pdfBuffer: Buffer, pageNumber: number, dpi: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const args = [
            '-f',
            pageNumber.toString(),
            '-l',
            pageNumber.toString(),
            '-png',
            '-r',
            dpi.toString(),
            '-singlefile',
            '-',
        ];
        const process = spawn('pdftoppm', args);

        const chunks: Buffer[] = [];
        let stderr = '';

        process.stdin.write(pdfBuffer);
        process.stdin.end();

        process.stdout.on('data', (data) => {
            chunks.push(Buffer.from(data));
        });

        process.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        process.on('close', (code) => {
            if (code !== 0) {
                return reject(new Error(`pdftoppm (page ${pageNumber}, dpi ${dpi}) exited with code ${code}: ${stderr}`));
            }

            resolve(Buffer.concat(chunks));
        });
    });
}

/**
 * Asks Gemini Vision to perform an exhaustive analysis of the page.
 */
async function analyzePageWithVision(pngBuffer: Buffer): Promise<VisionProduct[]> {
    if (!visionModel) return [];

    let retries = 3;
    while (retries > 0) {
        try {
            const prompt = `Você é um especialista em extração visual de dados com foco em processamento exaustivo de documentos. Sua tarefa é analisar todas as páginas do arquivo fornecido e extrair absolutamente todos os produtos sem deixar nenhum para trás.

REGRAS
1. Realize uma varredura completa em cada página. Garanta que a transição entre páginas não cause a perda de nenhum item.
2. Localize o nome do produto, o preço e o código de referência conhecido como Ref ID.
3. O Ref ID pode estar posicionado em qualquer local próximo ao produto. Identifique padrões de códigos alfanuméricos ou sequências numéricas.
4. Mesmo que o termo ESGOTADO esteja presente, você deve obrigatoriamente extrair o preço numérico original associado ao produto. Não ignore o valor nem o defina como zero caso o preço esteja visível no documento.
5. O nome do produto deve conter todos os detalhes extras como medidas e cores.

INSTRUÇÕES DE VARREDURA
Certifique-se de percorrer o documento do início ao fim. Verifique cada canto da página para encontrar produtos que possam estar em layouts não convencionais. A extração deve ser total e sem omissões. O fato de um item estar marcado como esgotado não deve impedir a coleta de seu valor monetário.

SAÍDA OBRIGATÓRIA
Retorne apenas um array JSON puro com todos os produtos. Não inclua explicações ou comentários.
IMPORTANTE: Para cada produto, inclua a chave "box_2d": [ymin, xmin, ymax, xmax] englobando a IMAGEM do produto.

Exemplo de saída:
[{"product_name": "Nome", "ref_id": "ID", "price": 0.00, "box_2d": [0,0,0,0]}]`;

            const imagePart = {
                inlineData: {
                    data: pngBuffer.toString('base64'),
                    mimeType: 'image/png',
                },
            };

            await delay(2000);
            const result = await visionModel.generateContent([prompt, imagePart]);
            const responseText = result.response.text();
            const jsonMatch = responseText.match(/\[[\s\S]*\]/);
            const jsonText = jsonMatch ? jsonMatch[0] : '[]';
            const detected = JSON.parse(jsonText);

            return Array.isArray(detected) ? detected : [];
        } catch (err: any) {
            if (err.status === 429) {
                console.warn('[VISION] Rate limit hit on page analysis. Retrying in 12s...');
                await delay(12000);
                retries--;
            } else {
                console.error('[VISION] Page analysis error:', err);
                return [];
            }
        }
    }

    return [];
}

function isSmallRenderedResult(width: number, height: number): boolean {
    const longSide = Math.max(width, height);
    const shortSide = Math.min(width, height);
    return longSide < 650 || shortSide < 320 || width * height < 180_000;
}

function clampCropBox(
    metadata: Metadata,
    box: [number, number, number, number]
): { left: number; top: number; width: number; height: number } | null {
    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;
    if (!width || !height) return null;

    const [ymin, xmin, ymax, xmax] = box;
    const left = Math.max(0, Math.floor((Math.min(xmin, xmax) / 1000) * width));
    const top = Math.max(0, Math.floor((Math.min(ymin, ymax) / 1000) * height));
    const cropWidth = Math.ceil((Math.abs(xmax - xmin) / 1000) * width);
    const cropHeight = Math.ceil((Math.abs(ymax - ymin) / 1000) * height);

    const safeWidth = Math.max(10, Math.min(width - left, cropWidth));
    const safeHeight = Math.max(10, Math.min(height - top, cropHeight));
    if (safeWidth <= 0 || safeHeight <= 0) return null;

    return { left, top, width: safeWidth, height: safeHeight };
}

async function cropVisionProduct(
    renderedPageBuffer: Buffer,
    product: VisionProduct,
    renderDpi: number
): Promise<ProcessedRenderCrop | null> {
    if (!product.box_2d || !Array.isArray(product.box_2d)) return null;

    const metadata = await sharp(renderedPageBuffer).metadata();
    const crop = clampCropBox(metadata, product.box_2d);
    if (!crop) return null;

    const extractedBuffer = await sharp(renderedPageBuffer)
        .extract(crop)
        .toBuffer();

    const processed = await processStoreImage(extractedBuffer);

    return {
        buffer: processed.buffer,
        width: processed.width,
        height: processed.height,
        renderDpi,
    };
}

function logProcessedItem(item: {
    ref: string;
    page: number;
    strategy: string;
    nativeWidth?: number;
    nativeHeight?: number;
    finalWidth?: number;
    finalHeight?: number;
    renderDpi?: number;
}) {
    console.log(
        [
            '[PDF][ITEM]',
            `ref=${item.ref}`,
            `page=${item.page}`,
            `strategy=${item.strategy}`,
            `native=${item.nativeWidth ?? '-'}x${item.nativeHeight ?? '-'}`,
            `final=${item.finalWidth ?? '-'}x${item.finalHeight ?? '-'}`,
            `render_dpi=${item.renderDpi ?? '-'}`,
        ].join(' ')
    );
}

const delay = (ms: number) => new Promise((res) => setTimeout(res, ms));

function buildPageRange(numPages: number, targetPage?: number): number[] {
    if (targetPage) return [targetPage];
    return Array.from({ length: numPages }, (_, index) => index + 1);
}

async function processNativeAssociations(
    page: StructuralPdfPage | undefined,
    analysis: StructuralPageAnalysis | null,
    validIds: Set<string> | undefined,
    results: ExtractedImage[],
    handledIds: Set<string>,
    onlyMapping: boolean
) {
    if (!page || !analysis?.isTabular) return;

    for (const association of analysis.associations) {
        const refId = String(association.refId || '').trim();
        if (!refId) continue;
        if (validIds && !validIds.has(refId)) continue;

        handledIds.add(refId);

        if (onlyMapping) {
            results.push({
                ean: refId,
                page: page.pageNumber,
                sourceStrategy: 'native',
                nativeWidth: association.image.nativeWidth,
                nativeHeight: association.image.nativeHeight,
            });
            continue;
        }

        if (!association.image.buffer || !isNativeImageViable(association.image)) {
            handledIds.delete(refId);
            continue;
        }

        const processed = await processStoreImage(association.image.buffer);
        results.push({
            ean: refId,
            buffer: processed.buffer,
            page: page.pageNumber,
            sourceStrategy: 'native',
            nativeWidth: association.image.nativeWidth,
            nativeHeight: association.image.nativeHeight,
            finalWidth: processed.width,
            finalHeight: processed.height,
        });

        logProcessedItem({
            ref: refId,
            page: page.pageNumber,
            strategy: 'native',
            nativeWidth: association.image.nativeWidth,
            nativeHeight: association.image.nativeHeight,
            finalWidth: processed.width,
            finalHeight: processed.height,
        });
    }
}

/**
 * Parses a PDF buffer using a hybrid pipeline:
 * 1) native structural extraction via pdftohtml -xml
 * 2) Vision + rendered crop fallback at 450 DPI, retrying 600 DPI when needed
 */
export async function processPdfBuffer(
    pdfBuffer: Buffer,
    validIds?: Set<string>,
    onProgress?: (msg: string) => void,
    targetPage?: number,
    onlyMapping: boolean = false
): Promise<ExtractedImage[]> {
    const results: ExtractedImage[] = [];
    const structuralExtractor = new PdfStructuralExtractor();

    try {
        const numPages = await getNumPages(pdfBuffer);
        let structuralPages: StructuralPdfPage[] = [];

        try {
            structuralPages = await structuralExtractor.extractFromBuffer(pdfBuffer);
        } catch (structuralError) {
            console.warn('[PDF][STRUCT] Structural extraction unavailable. Falling back to vision/render only.', structuralError);
        }

        console.log(`[PDF] Total Pages: ${numPages}`);
        const pagesToProcess = buildPageRange(numPages, targetPage);

        if (targetPage) {
            onProgress?.(`Usando índice: indo direto para a página ${targetPage}...`);
        }

        for (const pageNumber of pagesToProcess) {
            console.log(`[PDF] Processing Page ${pageNumber}...`);
            onProgress?.(`Processando página ${pageNumber}/${numPages}...`);

            const page = structuralPages.find((entry) => entry.pageNumber === pageNumber);
            const analysis = page ? structuralExtractor.analyzePage(page, validIds) : null;
            const handledIds = new Set<string>();
            const relevantAssociationCount = analysis
                ? analysis.associations.filter((association) => !validIds || validIds.has(String(association.refId || '').trim())).length
                : 0;

            if (analysis?.isTabular) {
                console.log(
                    `[PDF][STRUCT] page=${pageNumber} tabular=${analysis.isTabular} associations=${analysis.associations.length} unassigned=${analysis.unassignedImages}`
                );
            }

            await processNativeAssociations(page, analysis, validIds, results, handledIds, onlyMapping);

            const needsFallback =
                !analysis
                || !analysis.isTabular
                || relevantAssociationCount === 0
                || analysis.unassignedImages > 0
                || handledIds.size < relevantAssociationCount;

            if (!needsFallback) {
                continue;
            }

            let rendered450: Buffer | null = null;
            let rendered600: Buffer | null = null;

            try {
                rendered450 = await renderPageToBuffer(pdfBuffer, pageNumber, 450);
                const productsInPage = await analyzePageWithVision(rendered450);

                if (productsInPage.length === 0) {
                    console.log(`[PDF][VISION] Nenhum item identificado na página ${pageNumber}.`);
                    continue;
                }

                for (const product of productsInPage) {
                    const refId = String(product.ref_id || '').trim();
                    if (!refId) continue;
                    if (validIds && !validIds.has(refId)) continue;
                    if (handledIds.has(refId)) continue;

                    if (onlyMapping) {
                        results.push({
                            ean: refId,
                            page: pageNumber,
                            sourceStrategy: 'vision_fallback',
                            renderDpi: 450,
                        });
                        handledIds.add(refId);
                        continue;
                    }

                    let processed = await cropVisionProduct(rendered450, product, 450);
                    let sourceStrategy: ExtractedImage['sourceStrategy'] = 'render_450';

                    if (processed && isSmallRenderedResult(processed.width, processed.height)) {
                        rendered600 ??= await renderPageToBuffer(pdfBuffer, pageNumber, 600);
                        const retried = await cropVisionProduct(rendered600, product, 600);
                        if (retried) {
                            processed = retried;
                            sourceStrategy = 'render_600';
                        }
                    }

                    if (!processed) {
                        continue;
                    }

                    results.push({
                        ean: refId,
                        buffer: processed.buffer,
                        page: pageNumber,
                        sourceStrategy,
                        renderDpi: processed.renderDpi,
                        finalWidth: processed.width,
                        finalHeight: processed.height,
                    });

                    handledIds.add(refId);
                    logProcessedItem({
                        ref: refId,
                        page: pageNumber,
                        strategy: sourceStrategy,
                        finalWidth: processed.width,
                        finalHeight: processed.height,
                        renderDpi: processed.renderDpi,
                    });
                }
            } catch (pageError) {
                console.error(`[PDF] Error on page ${pageNumber}:`, pageError);
            }
        }
    } catch (err) {
        console.error('[PDF] Critical error:', err);
        throw err;
    }

    return results;
}
