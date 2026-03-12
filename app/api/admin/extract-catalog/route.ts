import { NextRequest, NextResponse } from 'next/server';
import { PdfExtractionService } from '@/lib/services/pdf-extraction-service';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

export const maxDuration = 300;

export async function POST(req: NextRequest) {
    try {
        const formData = await req.formData();
        const file = formData.get('file') as File | null;
        const maxPages = parseInt(formData.get('maxPages') as string || '999', 10);

        if (!file) {
            return NextResponse.json({ error: 'Nenhum arquivo enviado.' }, { status: 400 });
        }

        const encoder = new TextEncoder();
        const stream = new TransformStream();
        const writer = stream.writable.getWriter();
        const sendProgress = (data: any) => writer.write(encoder.encode(JSON.stringify(data) + '\n'));

        // Background processing
        (async () => {
            let tempPdfPath = '';
            try {
                sendProgress({ type: 'progress', message: `🚀 Iniciando processamento de ${file.name}...` });

                // 1. Salvar arquivo temporário
                const bytes = await file.arrayBuffer();
                const buffer = Buffer.from(bytes);
                const tempDir = path.join(process.cwd(), 'temp', 'uploads');
                if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

                tempPdfPath = path.join(tempDir, `${uuidv4()}.pdf`);
                fs.writeFileSync(tempPdfPath, buffer);

                // 2. Inicializar Serviço
                const pdfService = new PdfExtractionService();

                // 3. Processar Catálogo e Criar Banco de Imagens
                await pdfService.processCatalogToBank(tempPdfPath, file.name, maxPages, (msg: string) => {
                    sendProgress({ type: 'progress', message: msg });
                });

                sendProgress({ type: 'complete', message: '✨ Banco de Imagens atualizado com sucesso!' });

            } catch (err: any) {
                console.error('[API] Extraction Error:', err);
                sendProgress({ type: 'error', message: err.message });
            } finally {
                // Cleanup temp PDF
                if (tempPdfPath && fs.existsSync(tempPdfPath)) {
                    try { fs.unlinkSync(tempPdfPath); } catch (e) { }
                }
                writer.close();
            }
        })();

        return new Response(stream.readable, {
            headers: {
                'Content-Type': 'application/x-ndjson',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
            },
        });

    } catch (error: any) {
        console.error('[API] POST Error:', error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
