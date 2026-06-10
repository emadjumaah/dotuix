import { readFileSync } from 'node:fs';
import { unzipSync } from 'fflate';
import { safeParseManifest } from './manifest.js';
import type { Manifest, ValidateResult } from './types.js';
import { unpackBuffer } from './unpack.js';

const decoder = new TextDecoder();

/**
 * Validate a `.uix` archive: structural integrity + manifest schema.
 * Offline-first URL / CDN import checks are added in Day 6–7.
 *
 * @param uixPath  Absolute path to the `.uix` file.
 */
export async function validate(uixPath: string): Promise<ValidateResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Read ZIP from disk
  let data: Uint8Array;
  try {
    data = new Uint8Array(readFileSync(uixPath));
  } catch {
    return { valid: false, errors: [`Cannot read file: ${uixPath}`], warnings };
  }

  return validateBuffer(data);
}

/**
 * Validate a `.uix` buffer (universal, no file system required).
 */
export async function validateBuffer(data: Uint8Array): Promise<ValidateResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Unzip
  let files: Record<string, Uint8Array>;
  try {
    files = unpackBuffer(data);
  } catch {
    return {
      valid: false,
      errors: ['Invalid ZIP archive — file may be corrupted'],
      warnings,
    };
  }

  // manifest.json must exist
  if (!files['manifest.json']) {
    return {
      valid: false,
      errors: ['manifest.json not found in archive'],
      warnings,
    };
  }

  // Parse manifest
  let rawManifest: unknown;
  try {
    rawManifest = JSON.parse(decoder.decode(files['manifest.json']));
  } catch {
    return {
      valid: false,
      errors: ['manifest.json is not valid JSON'],
      warnings,
    };
  }

  const result = safeParseManifest(rawManifest);
  if (!result.success) {
    for (const issue of result.error.issues) {
      const path = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
      errors.push(`manifest.json — ${path}${issue.message}`);
    }
    return { valid: false, errors, warnings };
  }

  const manifest: Manifest = result.data;

  // Entry file must exist in archive
  if (!files[manifest.entry]) {
    errors.push(`Entry file "${manifest.entry}" declared in manifest.json is missing from archive`);
  }

  // Check expiry
  if (manifest.expires) {
    const expires = new Date(manifest.expires);
    if (Number.isNaN(expires.getTime())) {
      warnings.push(`manifest.json — expires "${manifest.expires}" is not a valid date`);
    } else if (expires < new Date()) {
      warnings.push(`File expired on ${manifest.expires}`);
    }
  }

  // ── Convention warnings (never block valid archives) ─────────────────────

  // Warn if media/document files are placed outside assets/ or files/
  const MEDIA_EXTS = new Set([
    'mp4',
    'webm',
    'mov',
    'avi', // video
    'mp3',
    'wav',
    'ogg',
    'aac',
    'm4a', // audio
    'pdf',
    'docx',
    'xlsx',
    'pptx', // documents
    'woff',
    'woff2',
    'ttf',
    'otf', // fonts (large)
  ]);
  const conventionPrefixes = ['assets/', 'files/'];
  const misplaced = Object.keys(files).filter((path) => {
    if (path === 'manifest.json' || path === 'data.db' || path === 'state.db') return false;
    const ext = path.split('.').pop()?.toLowerCase() ?? '';
    if (!MEDIA_EXTS.has(ext)) return false;
    return !conventionPrefixes.some((p) => path.startsWith(p));
  });
  if (misplaced.length > 0) {
    warnings.push(
      `Media/document files found outside assets/ or files/ — consider moving them: ${misplaced
        .slice(0, 3)
        .join(', ')}${misplaced.length > 3 ? ` (+${misplaced.length - 3} more)` : ''}`,
    );
  }

  // Warn if security.encryptedPaths references files not in the archive
  if (manifest.security?.encryptedPaths?.length) {
    for (const p of manifest.security.encryptedPaths) {
      if (!files[p]) {
        warnings.push(`security.encryptedPaths references "${p}" which is not in the archive`);
      }
    }
  }

  // Warn if security.auth is "pin" but no encryptedPaths or keySalt set
  if (manifest.security?.auth === 'pin') {
    if (!manifest.security.encryptedPaths?.length) {
      warnings.push(
        `security.auth is "pin" but security.encryptedPaths is empty — no files will be encrypted`,
      );
    }
    if (!manifest.security.keySalt) {
      warnings.push(
        `security.auth is "pin" but security.keySalt is missing — key derivation will fail`,
      );
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}
