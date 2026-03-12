import fs from 'fs';
import path from 'path';
import AdmZip from 'adm-zip';

const isLinux = process.platform === 'linux';
const projectRoot = process.cwd();
const vendorRoot = path.join(projectRoot, 'vendor', 'poppler');
const markerPath = path.join(vendorRoot, '.installed-from');
const defaultUrl = 'https://github.com/jeylabs/aws-lambda-poppler-layer/releases/latest/download/poppler.zip';
const downloadUrl = process.env.POPPLER_DOWNLOAD_URL || defaultUrl;

async function ensureDir(dir) {
    await fs.promises.mkdir(dir, { recursive: true });
}

async function removeDir(dir) {
    await fs.promises.rm(dir, { recursive: true, force: true });
}

async function chmodRecursive(rootDir) {
    if (!fs.existsSync(rootDir)) return;
    const entries = await fs.promises.readdir(rootDir, { withFileTypes: true });

    for (const entry of entries) {
        const fullPath = path.join(rootDir, entry.name);
        if (entry.isDirectory()) {
            await chmodRecursive(fullPath);
        } else if (entry.isFile()) {
            await fs.promises.chmod(fullPath, 0o755).catch(() => undefined);
        }
    }
}

async function findDirectoryContaining(startDir, childName) {
    const entries = await fs.promises.readdir(startDir, { withFileTypes: true });

    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const fullPath = path.join(startDir, entry.name);

        if (fs.existsSync(path.join(fullPath, childName))) {
            return fullPath;
        }

        const nested = await findDirectoryContaining(fullPath, childName);
        if (nested) return nested;
    }

    return null;
}

async function normalizeLayout() {
    if (fs.existsSync(path.join(vendorRoot, 'bin', 'pdfinfo'))) {
        return;
    }

    const nestedRoot = await findDirectoryContaining(vendorRoot, 'bin');
    if (!nestedRoot || nestedRoot === vendorRoot) {
        return;
    }

    const entries = await fs.promises.readdir(nestedRoot, { withFileTypes: true });
    for (const entry of entries) {
        const from = path.join(nestedRoot, entry.name);
        const to = path.join(vendorRoot, entry.name);
        if (from === to) continue;

        await fs.promises.rm(to, { recursive: true, force: true }).catch(() => undefined);
        await fs.promises.rename(from, to);
    }
}

async function main() {
    if (!isLinux) {
        console.log('[poppler] Skipping install: non-Linux environment.');
        return;
    }

    if (fs.existsSync(path.join(vendorRoot, 'bin', 'pdfinfo')) && fs.existsSync(markerPath)) {
        console.log('[poppler] Vendor bundle already present.');
        return;
    }

    console.log(`[poppler] Downloading Linux bundle from ${downloadUrl}`);
    const response = await fetch(downloadUrl);
    if (!response.ok) {
        throw new Error(`[poppler] Download failed: ${response.status} ${response.statusText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const zipBuffer = Buffer.from(arrayBuffer);
    const tempDir = path.join(projectRoot, '.tmp-poppler');

    await removeDir(tempDir);
    await ensureDir(tempDir);
    await removeDir(vendorRoot);
    await ensureDir(vendorRoot);

    const zipPath = path.join(tempDir, 'poppler.zip');
    await fs.promises.writeFile(zipPath, zipBuffer);

    const zip = new AdmZip(zipPath);
    zip.extractAllTo(vendorRoot, true);
    await normalizeLayout();

    await chmodRecursive(path.join(vendorRoot, 'bin'));
    await fs.promises.writeFile(markerPath, `${downloadUrl}\n`);
    await removeDir(tempDir);

    console.log('[poppler] Linux bundle installed into vendor/poppler');
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
