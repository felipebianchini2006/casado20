import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

const POPPLER_BINARIES = ['pdfinfo', 'pdftoppm', 'pdftohtml', 'pdftotext'] as const;

function getVendorRoot() {
    return path.join(process.cwd(), 'vendor', 'poppler');
}

function getVendorBinDir() {
    return process.env.POPPLER_BIN_DIR || path.join(getVendorRoot(), 'bin');
}

function getVendorLibDirs() {
    const vendorRoot = getVendorRoot();
    return [
        path.join(vendorRoot, 'lib'),
        path.join(vendorRoot, 'lib64'),
        path.join(vendorRoot, 'usr', 'lib'),
        path.join(vendorRoot, 'usr', 'lib64'),
    ].filter((dir) => fs.existsSync(dir));
}

function getExecutableExtensions(binary: string) {
    return process.platform === 'win32'
        ? [binary, `${binary}.exe`, `${binary}.cmd`]
        : [binary];
}

export function resolvePopplerBinary(binary: string): string {
    const preferredDir = getVendorBinDir();

    for (const candidate of getExecutableExtensions(binary)) {
        const absolute = path.join(preferredDir, candidate);
        if (fs.existsSync(absolute)) {
            return absolute;
        }
    }

    return binary;
}

export function getPopplerSpawnEnv(): NodeJS.ProcessEnv {
    const currentLdLibraryPath = process.env.LD_LIBRARY_PATH || '';
    const vendorLibDirs = getVendorLibDirs();

    return {
        ...process.env,
        LD_LIBRARY_PATH: [...vendorLibDirs, currentLdLibraryPath]
            .filter(Boolean)
            .join(':'),
    };
}

export function getMissingPopplerBinaries(
    binaries: string[] = [...POPPLER_BINARIES]
): string[] {
    const missing: string[] = [];

    for (const binary of binaries) {
        const resolved = resolvePopplerBinary(binary);
        const result = spawnSync(resolved, ['-v'], {
            stdio: 'ignore',
            env: getPopplerSpawnEnv(),
        });

        if (result.error && (result.error as NodeJS.ErrnoException).code === 'ENOENT') {
            missing.push(binary);
        }
    }

    return missing;
}

export function assertPopplerAvailable(binaries?: string[]) {
    const missing = getMissingPopplerBinaries(binaries);
    if (missing.length === 0) return;

    throw new Error(
        `Binarios Poppler indisponiveis no runtime: ${missing.join(', ')}. `
        + 'Verifique se o bundle foi baixado para vendor/poppler durante o build e incluido no tracing da rota.'
    );
}
