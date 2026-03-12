import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import fsSync from 'fs';
import os from 'os';
import path from 'path';
import sharp from 'sharp';
import * as cheerio from 'cheerio';
import { getPopplerSpawnEnv, resolvePopplerBinary } from './poppler-runtime';

const execFileAsync = promisify(execFile);

export interface StructuralPdfImageNode {
    top: number;
    left: number;
    width: number;
    height: number;
    src: string;
    absoluteSrc: string;
    buffer?: Buffer;
    nativeWidth?: number;
    nativeHeight?: number;
}

export interface StructuralPdfTextNode {
    top: number;
    left: number;
    width: number;
    height: number;
    content: string;
}

export interface StructuralPdfPage {
    pageNumber: number;
    width: number;
    height: number;
    images: StructuralPdfImageNode[];
    texts: StructuralPdfTextNode[];
}

export interface NativeImageAssociation {
    refId: string;
    confidence: number;
    pageNumber: number;
    image: StructuralPdfImageNode;
    matchedTexts: StructuralPdfTextNode[];
    reason: string;
}

export interface StructuralPageAnalysis {
    isTabular: boolean;
    associations: NativeImageAssociation[];
    unassignedImages: number;
    reason: string;
}

interface CodeCandidate {
    refId: string;
    score: number;
}

function parseMetric(value: string | undefined): number {
    if (!value) return 0;
    return Number.parseFloat(value) || 0;
}

function normalizeRefId(value: string): string {
    return value.trim().toUpperCase().replace(/\s+/g, '');
}

function extractCodeCandidates(content: string): string[] {
    const normalized = content
        .toUpperCase()
        .replace(/[|]/g, ' ')
        .replace(/\s+/g, ' ');

    const matches = normalized.match(/\b[A-Z0-9][A-Z0-9./_-]{2,}\b/g) ?? [];
    return [...new Set(matches)]
        .map((token) => token.replace(/[.,;:]$/, '').trim())
        .filter((token) => {
            if (token.length < 4 || token.length > 24) return false;
            if (/^\d+[.,]\d+$/.test(token)) return false;
            if (/^(R\$|UN|PCS|CX|ITEM|REF)$/i.test(token)) return false;
            return /[A-Z]/.test(token) || /^\d{6,14}$/.test(token);
        });
}

function verticalOverlap(aTop: number, aHeight: number, bTop: number, bHeight: number): number {
    const start = Math.max(aTop, bTop);
    const end = Math.min(aTop + aHeight, bTop + bHeight);
    return Math.max(0, end - start);
}

function buildValidIdLookup(validIds?: Set<string>): Map<string, string> {
    const lookup = new Map<string, string>();
    if (!validIds) return lookup;

    for (const value of validIds) {
        lookup.set(normalizeRefId(value), value);
    }

    return lookup;
}

function isConfidentAssociation(bestScore: number, secondScore: number, hasValidId: boolean): boolean {
    if (hasValidId) {
        return bestScore >= 140 && bestScore - secondScore >= 12;
    }

    return bestScore >= 80 && bestScore - secondScore >= 10;
}

export function isNativeImageViable(image: StructuralPdfImageNode): boolean {
    const nativeWidth = image.nativeWidth ?? 0;
    const nativeHeight = image.nativeHeight ?? 0;
    const longSide = Math.max(nativeWidth, nativeHeight);
    const shortSide = Math.min(nativeWidth, nativeHeight);
    const area = nativeWidth * nativeHeight;

    if (!nativeWidth || !nativeHeight) return false;
    if (longSide < 280) return false;
    if (shortSide < 180) return false;
    if (area < 70_000) return false;

    return true;
}

export class PdfStructuralExtractor {
    async extractFromBuffer(pdfBuffer: Buffer): Promise<StructuralPdfPage[]> {
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'catalog-struct-buffer-'));
        const tempPdfPath = path.join(tempDir, 'source.pdf');

        try {
            await fs.writeFile(tempPdfPath, pdfBuffer);
            return await this.extractFromPath(tempPdfPath);
        } finally {
            await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
        }
    }

    async extractFromPath(pdfPath: string): Promise<StructuralPdfPage[]> {
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'catalog-struct-'));
        const outputBase = path.join(tempDir, 'catalog');
        const xmlPath = `${outputBase}.xml`;

        try {
            await execFileAsync(
                resolvePopplerBinary('pdftohtml'),
                ['-xml', '-hidden', '-nodrm', pdfPath, outputBase],
                {
                    maxBuffer: 32 * 1024 * 1024,
                    env: getPopplerSpawnEnv(),
                }
            );

            const xmlContent = await fs.readFile(xmlPath, 'utf8');
            const $ = cheerio.load(xmlContent, { xmlMode: true });
            const pageNodes = $('pdf2xml > page').toArray();
            const pages: StructuralPdfPage[] = [];

            for (let index = 0; index < pageNodes.length; index++) {
                const pageNode = pageNodes[index];
                const pageNumber = parseMetric($(pageNode).attr('number')) || index + 1;
                const width = parseMetric($(pageNode).attr('width'));
                const height = parseMetric($(pageNode).attr('height'));

                const images: StructuralPdfImageNode[] = [];
                const texts: StructuralPdfTextNode[] = [];

                const imageNodes = $(pageNode).find('image').toArray();
                for (const imageNode of imageNodes) {
                    const src = $(imageNode).attr('src') || '';
                    const absoluteSrc = path.resolve(tempDir, src);
                    const image: StructuralPdfImageNode = {
                        top: parseMetric($(imageNode).attr('top')),
                        left: parseMetric($(imageNode).attr('left')),
                        width: parseMetric($(imageNode).attr('width')),
                        height: parseMetric($(imageNode).attr('height')),
                        src,
                        absoluteSrc,
                    };

                    try {
                        if (!fsSync.existsSync(absoluteSrc)) {
                            images.push(image);
                            continue;
                        }

                        image.buffer = await fs.readFile(absoluteSrc);
                        const metadata = await sharp(image.buffer).metadata();
                        image.nativeWidth = metadata.width ?? undefined;
                        image.nativeHeight = metadata.height ?? undefined;
                    } catch {
                        image.buffer = undefined;
                    }

                    images.push(image);
                }

                const textNodes = $(pageNode).find('text').toArray();
                for (const textNode of textNodes) {
                    const content = $(textNode).text().replace(/\s+/g, ' ').trim();
                    if (!content) continue;

                    texts.push({
                        top: parseMetric($(textNode).attr('top')),
                        left: parseMetric($(textNode).attr('left')),
                        width: parseMetric($(textNode).attr('width')),
                        height: parseMetric($(textNode).attr('height')),
                        content,
                    });
                }

                pages.push({
                    pageNumber,
                    width,
                    height,
                    images,
                    texts,
                });
            }

            return pages;
        } finally {
            await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
        }
    }

    analyzePage(page: StructuralPdfPage, validIds?: Set<string>): StructuralPageAnalysis {
        const validIdLookup = buildValidIdLookup(validIds);
        const usableImages = page.images
            .filter((image) => image.width >= 40 && image.height >= 40)
            .sort((a, b) => a.top - b.top);

        if (usableImages.length < 2 || page.texts.length === 0) {
            return {
                isTabular: false,
                associations: [],
                unassignedImages: usableImages.length,
                reason: 'not-enough-rows',
            };
        }

        const leftBound = usableImages.map((image) => image.left);
        const leftSpread = Math.max(...leftBound) - Math.min(...leftBound);
        const rightEdgeAverage =
            usableImages.reduce((sum, image) => sum + image.left + image.width, 0) / usableImages.length;

        const rowCandidates = usableImages.map((image) => {
            const centerY = image.top + image.height / 2;
            const relatedTexts = page.texts.filter((text) => {
                if (text.left + text.width <= image.left + image.width * 0.35) return false;
                const overlap = verticalOverlap(image.top, image.height, text.top, text.height);
                const textCenterY = text.top + text.height / 2;
                const maxDistance = Math.max(image.height * 0.65, 24);

                return overlap >= Math.min(image.height, text.height) * 0.12
                    || Math.abs(centerY - textCenterY) <= maxDistance;
            });

            return { image, texts: relatedTexts };
        });

        const rowsWithText = rowCandidates.filter((row) => row.texts.length > 0);
        const rightSideTextCount = page.texts.filter((text) => text.left >= rightEdgeAverage - 16).length;
        const isTabular =
            usableImages.length >= 2
            && rowsWithText.length >= Math.max(2, Math.ceil(usableImages.length * 0.6))
            && leftSpread <= Math.max(page.width * 0.16, 90)
            && rightSideTextCount >= rowsWithText.length;

        if (!isTabular) {
            return {
                isTabular: false,
                associations: [],
                unassignedImages: usableImages.length,
                reason: 'layout-not-tabular',
            };
        }

        const associations: NativeImageAssociation[] = [];

        for (const row of rowsWithText) {
            const combinedText = row.texts
                .map((text) => text.content)
                .join(' ')
                .replace(/\s+/g, ' ')
                .trim();

            const rawCandidates = [
                ...row.texts.flatMap((text) => extractCodeCandidates(text.content)),
                ...extractCodeCandidates(combinedText),
            ];

            const scored = new Map<string, number>();

            for (const token of rawCandidates) {
                const normalized = normalizeRefId(token);
                const canonical = validIdLookup.get(normalized) ?? token;
                const hasValidId = validIdLookup.has(normalized);
                const current = scored.get(canonical) ?? 0;
                const base = hasValidId ? 120 : 55;
                const digitBonus = /^\d{6,14}$/.test(normalized) ? 12 : 6;
                const nextScore = current + base + digitBonus;

                scored.set(canonical, nextScore);
            }

            const candidates: CodeCandidate[] = [...scored.entries()]
                .map(([refId, score]) => ({ refId, score }))
                .sort((a, b) => b.score - a.score);

            if (candidates.length === 0) {
                continue;
            }

            const bestCandidate = candidates[0];
            const secondScore = candidates[1]?.score ?? 0;
            const normalizedBest = normalizeRefId(bestCandidate.refId);
            const hasValidId = validIdLookup.has(normalizedBest);

            if (!isConfidentAssociation(bestCandidate.score, secondScore, hasValidId)) {
                continue;
            }

            const confidence = Math.min(
                0.98,
                hasValidId
                    ? 0.75 + Math.min(0.2, (bestCandidate.score - secondScore) / 100)
                    : 0.62 + Math.min(0.16, (bestCandidate.score - secondScore) / 120)
            );

            associations.push({
                refId: bestCandidate.refId,
                confidence,
                pageNumber: page.pageNumber,
                image: row.image,
                matchedTexts: row.texts,
                reason: hasValidId ? 'tabular-native-valid-id' : 'tabular-native-proximity',
            });
        }

        const uniqueAssociations = new Map<string, NativeImageAssociation>();
        for (const association of associations) {
            const existing = uniqueAssociations.get(association.refId);
            if (!existing || association.confidence > existing.confidence) {
                uniqueAssociations.set(association.refId, association);
            }
        }

        return {
            isTabular: true,
            associations: [...uniqueAssociations.values()],
            unassignedImages: Math.max(0, usableImages.length - uniqueAssociations.size),
            reason: 'tabular-layout-detected',
        };
    }
}
