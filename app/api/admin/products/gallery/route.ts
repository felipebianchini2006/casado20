import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseClient';
import { processStoreImage } from '@/lib/services/store-image-pipeline';

export async function POST(req: NextRequest) {
    try {
        const formData = await req.formData();
        const file = formData.get('file') as File;
        const sku = formData.get('sku') as string;
        const ean = formData.get('ean') as string;
        const slot = parseInt(formData.get('slot') as string || '0'); // 0, 1, 2

        if (!file || !sku) {
            return NextResponse.json({ success: false, error: 'File and SKU are required' }, { status: 400 });
        }

        console.log(`[GalleryUpload] Processing image for SKU: ${sku}, Slot: ${slot}`);

        // 1. Process Image (WebP + Resize)
        const bytes = await file.arrayBuffer();
        const buffer = Buffer.from(bytes);

        const processedImage = await processStoreImage(buffer);
        const processedBuffer = processedImage.buffer;

        if (!supabaseAdmin) throw new Error('Supabase Admin not initialized');

        // 2. Upload to Storage
        // Slot 0 (Main) -> sku.webp
        // Slot 1 -> sku_2.webp
        // Slot 2 -> sku_3.webp
        const suffix = slot === 0 ? '' : `_${slot + 1}`;
        const fileName = `${sku}${suffix}.webp`;

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

        // 4. Update product_images table
        // We delete by image_url to avoid duplicates if the same image is uploaded, 
        // but better to delete by SKU and slot logic if we had a slot column.
        // Since we don't have a slot column, we use the image_url suffix as a proxy or just check existing.

        // Robust way: find if there is an image with this exact URL already linked
        if (slot === 0) {
            await supabaseAdmin
                .from('product_images')
                .update({ is_primary: false })
                .eq('sku', sku);
        }

        const { data: existing } = await supabaseAdmin
            .from('product_images')
            .select('id')
            .eq('sku', sku)
            .eq('image_url', publicUrl)
            .maybeSingle();

        if (!existing) {
            const { error: insertError } = await supabaseAdmin
                .from('product_images')
                .insert({
                    sku: sku,
                    ean: ean || null,
                    image_url: publicUrl,
                    source: 'manual_upload',
                    is_primary: slot === 0
                });
            if (insertError) throw insertError;
        } else {
            // Update timestamp or metadata if needed
            await supabaseAdmin
                .from('product_images')
                .update({ is_primary: slot === 0 })
                .eq('id', existing.id);
            console.log(`[GalleryUpload] Updated existing image entry for SKU: ${sku}, URL: ${publicUrl}`);
        }

        // 5. If it's Slot 0, update the main product image too
        if (slot === 0) {
            const { error: productUpdateError } = await supabaseAdmin
                .from('products')
                .update({ image_url: publicUrl })
                .eq('id', sku);

            if (productUpdateError) console.error('[GalleryUpload] Error updating products table:', productUpdateError);
            else console.log(`[GalleryUpload] Updated main product image for SKU: ${sku} to ${publicUrl}`);
        }

        return NextResponse.json({
            success: true,
            url: publicUrl,
            message: `Imagem vinculada ao Slot ${slot + 1} com sucesso`,
            width: processedImage.width,
            height: processedImage.height,
        });

    } catch (error: any) {
        console.error('[GalleryUpload] Error:', error);
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
}

export async function DELETE(req: NextRequest) {
    try {
        const body = await req.json();
        const { sku, imageUrl } = body;

        if (!sku || !imageUrl) {
            return NextResponse.json({ success: false, error: 'SKU and imageUrl are required' }, { status: 400 });
        }

        if (!supabaseAdmin) throw new Error('Supabase Admin not initialized');

        console.log(`[GalleryDelete] Attempting to delete image for SKU: ${sku}, URL: ${imageUrl}`);

        // 1. Delete from product_images table
        const { error: deleteError } = await supabaseAdmin
            .from('product_images')
            .delete()
            .eq('sku', sku)
            .eq('image_url', imageUrl);

        if (deleteError) {
            console.error('[GalleryDelete] DB Error:', deleteError);
            throw deleteError;
        }

        // 2. If it was the primary image in products table, set to null
        const { data: product } = await supabaseAdmin
            .from('products')
            .select('image_url')
            .eq('id', sku)
            .maybeSingle();

        if (product?.image_url === imageUrl) {
            console.log(`[GalleryDelete] Clearing primary image reference in products table for SKU: ${sku}`);
            await supabaseAdmin
                .from('products')
                .update({ image_url: null })
                .eq('id', sku);
        }

        return NextResponse.json({ success: true, message: 'Imagem removida com sucesso' });

    } catch (error: any) {
        console.error('[GalleryDelete] Error:', error);
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
}
