import sharp from 'sharp';

export interface StoreImagePipelineOptions {
    maxLongSide?: number;
    quality?: number;
    effort?: number;
}

export interface StoreImagePipelineResult {
    buffer: Buffer;
    width: number;
    height: number;
    originalWidth: number;
    originalHeight: number;
    format: 'webp';
}

const DEFAULT_MAX_LONG_SIDE = 1600;
const DEFAULT_QUALITY = 92;
const DEFAULT_EFFORT = 6;

export async function processStoreImage(
    inputBuffer: Buffer,
    options: StoreImagePipelineOptions = {}
): Promise<StoreImagePipelineResult> {
    const image = sharp(inputBuffer, { limitInputPixels: false }).rotate();
    const metadata = await image.metadata();
    const originalWidth = metadata.width ?? 0;
    const originalHeight = metadata.height ?? 0;

    const maxLongSide = options.maxLongSide ?? DEFAULT_MAX_LONG_SIDE;
    const quality = options.quality ?? DEFAULT_QUALITY;
    const effort = options.effort ?? DEFAULT_EFFORT;

    const resizeOptions =
        originalWidth >= originalHeight
            ? { width: maxLongSide, height: undefined }
            : { width: undefined, height: maxLongSide };

    const { data, info } = await sharp(inputBuffer, { limitInputPixels: false })
        .rotate()
        .resize({
            ...resizeOptions,
            fit: 'inside',
            withoutEnlargement: true,
        })
        .sharpen(0.6)
        .webp({
            quality,
            effort,
            smartSubsample: true,
        })
        .toBuffer({ resolveWithObject: true });

    return {
        buffer: data,
        width: info.width,
        height: info.height,
        originalWidth,
        originalHeight,
        format: 'webp',
    };
}
