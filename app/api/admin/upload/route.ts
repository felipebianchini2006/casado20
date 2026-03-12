import { NextRequest, NextResponse } from 'next/server';
import { processPdfBuffer } from '@/lib/pdf-processor';
import { supabaseAdmin } from '@/lib/supabaseClient';

export const maxDuration = 300;

export async function POST(req: NextRequest) {
    try {
        if (!supabaseAdmin) {
            return NextResponse.json({ error: 'Configuração de servidor incompleta.' }, { status: 500 });
        }

        const formData = await req.formData();
        const file = formData.get('file') as File | null;

        if (!file) {
            return NextResponse.json({ error: 'Nenhum arquivo enviado.' }, { status: 400 });
        }

        const encoder = new TextEncoder();
        const stream = new TransformStream();
        const writer = stream.writable.getWriter();
        const sendProgress = (data: any) => writer.write(encoder.encode(JSON.stringify(data) + '\n'));

        // Background processing to avoid timeout blocking
        (async () => {
            try {
                sendProgress({ type: 'progress', message: `🚀 Iniciando processamento de ${file.name}...` });

                // 1. Get Valid IDs from Supabase (MUCH faster than Hiper API)
                sendProgress({ type: 'progress', message: '🔎 Carregando dicionário de produtos do banco...' });
                const { data: dbProducts } = await supabaseAdmin
                    .from('products')
                    .select('ean, ref');

                const validIds = new Set<string>();
                dbProducts?.forEach(p => {
                    if (p.ean) validIds.add(String(p.ean).trim());
                    if (p.ref) validIds.add(String(p.ref).trim());
                });
                sendProgress({ type: 'progress', message: `✅ ${validIds.size} referências carregadas para validação.` });

                // 2. Convert File to Buffer
                const buffer = Buffer.from(await file.arrayBuffer());

                // 3. Process PDF with our new Gemini-Native Motor
                const extracted = await processPdfBuffer(
                    buffer,
                    validIds,
                    (msg) => sendProgress({ type: 'progress', message: msg })
                );

                // 4. Handle Results (Upload and Link)
                let successCount = 0;
                let errorCount = 0;

                for (const item of extracted) {
                    if (!item.buffer) continue;

                    const fileName = `${item.ean}.webp`;
                    try {
                        // Upload image
                        const { error: uploadError } = await supabaseAdmin.storage
                            .from('products')
                            .upload(fileName, item.buffer, {
                                contentType: 'image/webp',
                                upsert: true
                            });

                        if (uploadError) throw uploadError;

                        const { data: publicUrlData } = supabaseAdmin.storage
                            .from('products')
                            .getPublicUrl(fileName);

                        // Update product table (trying both EAN and Ref)
                        const { error: updateError } = await supabaseAdmin
                            .from('products')
                            .update({ image_url: publicUrlData.publicUrl })
                            .or(`ean.eq.${item.ean},ref.eq.${item.ean}`);

                        if (updateError) {
                            sendProgress({ type: 'progress', message: `⚠️ [${item.ean}] Imagem salva, mas não consegui vincular ao produto.` });
                        } else {
                            sendProgress({
                                type: 'progress',
                                message: `✅ [${item.ean}] ${item.sourceStrategy} ${item.finalWidth || '-'}x${item.finalHeight || '-'} (pág. ${item.page})`,
                            });
                            successCount++;
                        }
                    } catch (err: any) {
                        errorCount++;
                        sendProgress({ type: 'progress', message: `❌ [${item.ean}] Erro: ${err.message}` });
                    }
                }

                // Log summary to catalog_uploads
                await supabaseAdmin.from('catalog_uploads').insert({
                    filename: file.name,
                    status: errorCount === 0 ? 'success' : 'partial',
                    log_summary: `Extraídos: ${extracted.length}, Sucesso: ${successCount}, Erro: ${errorCount}`
                });

                sendProgress({
                    type: 'result',
                    success: successCount,
                    errors: errorCount,
                    total: extracted.length
                });

            } catch (err: any) {
                console.error('[API] Processing Error:', err);
                sendProgress({ type: 'error', error: err.message });
            } finally {
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
        console.error('API Request Error:', error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
