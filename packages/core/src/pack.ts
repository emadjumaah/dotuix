import { readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { zipSync } from 'fflate';
import { parseManifest } from './manifest.js';

/** File extensions stored without compression (already compressed or binary). */
const STORE_EXTENSIONS = new Set([
  '.db',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
  '.svg',
  '.mp4',
  '.mp3',
  '.webm',
  '.wasm',
]);

/** Directories never included in the archive. */
const EXCLUDED_DIRS = new Set(['node_modules', '.git', 'dist', '.turbo', '.vscode', '.idea']);

function compressionLevel(filename: string): 0 | 6 {
  return STORE_EXTENSIONS.has(extname(filename).toLowerCase()) ? 0 : 6;
}

function walkDir(dir: string, base: string): { relPath: string; absPath: string }[] {
  const results: { relPath: string; absPath: string }[] = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (EXCLUDED_DIRS.has(entry.name)) continue;

    const absPath = join(dir, entry.name);
    const relPath = relative(base, absPath).replace(/\\/g, '/');

    if (entry.isDirectory()) {
      results.push(...walkDir(absPath, base));
    } else if (entry.isFile()) {
      results.push({ relPath, absPath });
    }
  }

  return results;
}

/**
 * Pack a source directory into a `.uix` archive.
 *
 * Reads `manifest.json` from `srcDir`, validates it, then compresses all files
 * using DEFLATE for text assets and STORE for binary / already-compressed assets.
 *
 * @param srcDir  Absolute path to the source directory containing `manifest.json`.
 * @param outputPath  Absolute path where the `.uix` file will be written.
 */
export async function pack(srcDir: string, outputPath: string): Promise<void> {
  // Read and validate manifest
  const manifestPath = join(srcDir, 'manifest.json');
  let rawManifest: string;
  try {
    rawManifest = readFileSync(manifestPath, 'utf-8');
  } catch {
    throw new Error(`manifest.json not found in ${srcDir}`);
  }

  const manifest = parseManifest(JSON.parse(rawManifest));

  // Verify the declared entry file exists
  try {
    statSync(join(srcDir, manifest.entry));
  } catch {
    throw new Error(
      `Entry file "${manifest.entry}" declared in manifest.json does not exist in ${srcDir}`,
    );
  }

  // Collect all files and build the fflate file map
  const entries = walkDir(srcDir, srcDir);
  const zipFiles: Parameters<typeof zipSync>[0] = {};

  for (const { relPath, absPath } of entries) {
    const content = new Uint8Array(readFileSync(absPath));
    const level = compressionLevel(relPath);
    zipFiles[relPath] = [content, { level }];
  }

  // Create ZIP and write atomically: write to .tmp then rename
  const zipped = zipSync(zipFiles);
  const tmpPath = `${outputPath}.tmp`;
  writeFileSync(tmpPath, zipped);

  // Atomic rename (same filesystem, so this is O(1) and crash-safe)
  renameSync(tmpPath, outputPath);
}

/**
 * Pack an in-memory file map into a `.uix` buffer (universal, no file system required).
 *
 * @param files  Map of archive-root-relative paths to file contents.
 * @returns  A `Uint8Array` containing the ZIP archive.
 */
export function packBuffer(files: Record<string, Uint8Array>): Uint8Array {
  const zipFiles: Parameters<typeof zipSync>[0] = {};

  for (const [relPath, content] of Object.entries(files)) {
    zipFiles[relPath] = [content, { level: compressionLevel(relPath) }];
  }

  return zipSync(zipFiles);
}

export { compressionLevel, STORE_EXTENSIONS, EXCLUDED_DIRS };
