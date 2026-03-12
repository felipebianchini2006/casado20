import { supabaseAdmin } from '@/lib/supabaseClient';
import fs from 'fs';
import path from 'path';
import { processStoreImage } from './store-image-pipeline';

function logDebug(msg: string) {
    const p = path.join(process.cwd(), 'debug-enrichment.log');
    try {
        fs.appendFileSync(p, new Date().toISOString() + ': ' + msg + '\n');
    } catch (e) {
        console.error('Logging failed', e);
    }
}

export class ImageEnrichmentService {

    /**
     * Common logic to resize, convert to WebP, upload to Supabase and save to DB.
     * This will be used by Manual Uploads and PDF processing.
     */
    async uploadAndSaveProcessedImage(product: { id: string, name: string, ean?: string, sku: string, ncm?: string }, buffer: Buffer, source: string) {
        if (!supabaseAdmin) throw new Error('Supabase Admin not initialized');

        logDebug(`[Enrichment] Processing and uploading image from ${source}...`);

        const processedBuffer = (await processStoreImage(buffer)).buffer;

        const imageKey = product.ean || product.sku;
        const fileName = `${imageKey}.webp`;

        const { error: uploadError } = await supabaseAdmin.storage
            .from('products')
            .upload(fileName, processedBuffer, { contentType: 'image/webp', upsert: true });

        if (uploadError) {
            console.error('[Enrichment] Storage Error:', uploadError);
            return { success: false, reason: 'upload_failed' };
        }

        const { data: { publicUrl } } = supabaseAdmin.storage.from('products').getPublicUrl(fileName);

        // --- DUAL SAVE STRATEGY (Consistent & Fast) ---

        // 1. Update Main Mirror Table (products)
        await supabaseAdmin
            .from('products')
            .update({ image_url: publicUrl })
            .eq('id', product.id);

        // 2. Update Enrichment Table (product_images)
        await supabaseAdmin.from('product_images').delete().eq('sku', product.sku);

        const { error: insertError } = await supabaseAdmin.from('product_images').insert({
            sku: product.sku,
            ean: product.ean || null,
            image_url: publicUrl,
            source: source,
            is_primary: true
        });

        if (insertError) {
            console.error('[Enrichment] DB Error (product_images):', insertError);
            return { success: false, reason: 'db_save_failed' };
        }

        logDebug(`[Enrichment] Success! SKU: ${product.sku} (Source: ${source})`);
        return { success: true, url: publicUrl, confidence: 100 };
    }
}
