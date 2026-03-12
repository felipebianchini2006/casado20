import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseClient';
import { processStoreImage } from '@/lib/services/store-image-pipeline';

export async function POST(req: NextRequest) {
    try {
        const formData = await req.formData();
        const file = formData.get('file') as File;
        const sku = formData.get('sku') as string;
        const ean = formData.get('ean') as string;

        if (!file || !sku) {
            return NextResponse.json({ success: false, error: 'File and SKU are required' }, { status: 400 });
        }

        console.log(`[ManualUpload] Processing image for SKU: ${sku}`);

        // 1. Process Image (WebP + Resize)
        const bytes = await file.arrayBuffer();
        const buffer = Buffer.from(bytes);

        const processedImage = await processStoreImage(buffer);
        const processedBuffer = processedImage.buffer;

        // 2. Upload to Storage (Bucket: products)
        const fileName = `${sku}.webp`;

        if (!supabaseAdmin) throw new Error('Supabase Admin not initialized');

        const { error: uploadError } = await supabaseAdmin
            .storage
            .from('products')
            .upload(fileName, processedBuffer, {
                contentType: 'image/webp',
                upsert: true
            });

        if (uploadError) throw uploadError;

        // 3. Get Public URL
        const { data: { publicUrl } } = supabaseAdmin
            .storage
            .from('products')
            .getPublicUrl(fileName);

        // 4. Force Update into product_images table
        // We delete first to ensure any duplicate or conflict is removed,
        // then insert fresh. This is the most robust way to ensure the link works
        // across all Supabase configurations.
        await supabaseAdmin
            .from('product_images')
            .delete()
            .eq('sku', sku);

        const { error: insertError } = await supabaseAdmin
            .from('product_images')
            .insert({
                sku: sku,
                ean: ean || null,
                image_url: publicUrl,
                source: 'manual_upload',
                is_primary: true
            });

        if (insertError) throw insertError;

        // 5. Update the mirror products table too (This is what the frontend sees)
        const { error: productUpdateError } = await supabaseAdmin
            .from('products')
            .update({ image_url: publicUrl })
            .eq('id', sku);

        if (productUpdateError) {
            console.error('[ManualUpload] Error updating products table:', productUpdateError);
        }

        return NextResponse.json({
            success: true,
            url: publicUrl,
            message: 'Image uploaded and linked successfully',
            width: processedImage.width,
            height: processedImage.height,
        });

    } catch (error: any) {
        console.error('[ManualUpload] Error:', error);
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
}
