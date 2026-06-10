import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { unzipSync, zipSync } from 'fflate';
import { compressionLevel } from './pack.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function toBase64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function fromBase64url(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'base64url'));
}

/** Recursively sort object keys for deterministic JSON serialisation. */
function sortKeys(val: unknown): unknown {
  if (Array.isArray(val)) return val.map(sortKeys);
  if (val !== null && typeof val === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(val).sort()) out[k] = sortKeys((val as Record<string, unknown>)[k]);
    return out;
  }
  return val;
}

// ---------------------------------------------------------------------------
// Canonical signing payload
// ---------------------------------------------------------------------------

/**
 * Build the deterministic byte sequence that is signed / verified.
 *
 * Format (UTF-8):
 *   DOTUIX-SIGN-V1\n
 *   manifest:<compact-json-without-signature-field>\n
 *   file:<sorted-path>:<sha256-hex>\n
 *   ...
 *
 * The manifest JSON is serialised with recursively sorted keys so the output
 * is identical regardless of how the JSON was originally formatted.
 */
function buildPayload(
  files: Record<string, Uint8Array>,
  manifestWithoutSig: Record<string, unknown>,
): Uint8Array {
  const manifestJson = JSON.stringify(sortKeys(manifestWithoutSig));
  const sortedPaths = Object.keys(files)
    .filter((p) => p !== 'manifest.json' && p !== 'state.db')
    .sort();

  const lines = [
    'DOTUIX-SIGN-V1',
    `manifest:${manifestJson}`,
    ...sortedPaths.map((p) => `file:${p}:${hex(sha256(files[p]))}`),
  ];
  return new TextEncoder().encode(lines.join('\n'));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface KeyPair {
  /** 32-byte Ed25519 private-key seed encoded as base64url. Keep secret. */
  privateKey: string;
  /** 32-byte Ed25519 public key encoded as base64url. Safe to share. */
  publicKey: string;
}

/** Generate a fresh Ed25519 key pair. */
export function generateKeyPair(): KeyPair {
  const priv = ed25519.utils.randomSecretKey();
  const pub = ed25519.getPublicKey(priv);
  return { privateKey: toBase64url(priv), publicKey: toBase64url(pub) };
}

/**
 * Derive the base64url-encoded Ed25519 public key from a 32-byte private-key seed.
 * Useful when you need to display or embed the public key given only the seed file.
 */
export function publicKeyFromSeed(privateKeySeed: Uint8Array): string {
  return toBase64url(ed25519.getPublicKey(privateKeySeed));
}

/**
 * Sign arbitrary bytes with an Ed25519 private-key seed.
 * Returns the raw 64-byte signature (not base64-encoded).
 * Use for custom signing schemes such as license tokens.
 */
export function signBytes(data: Uint8Array, privateKeySeed: Uint8Array): Uint8Array {
  return ed25519.sign(data, privateKeySeed);
}

/**
 * Sign a `.uix` buffer and return a new buffer whose `manifest.json` contains
 * a populated `signature` block.
 */
export function signBuffer(data: Uint8Array, privateKeySeed: Uint8Array): Uint8Array {
  const files = unzipSync(data);
  const rawManifest = files['manifest.json'];
  if (!rawManifest) throw new Error('manifest.json not found in archive');

  const manifest = JSON.parse(new TextDecoder().decode(rawManifest)) as Record<string, unknown>;

  // Strip existing signature before computing payload
  const { signature: _old, ...manifestWithoutSig } = manifest;

  const payload = buildPayload(files, manifestWithoutSig);
  const sigBytes = ed25519.sign(payload, privateKeySeed);
  const pubKey = ed25519.getPublicKey(privateKeySeed);

  const newManifest: Record<string, unknown> = {
    ...manifest,
    signature: {
      algorithm: 'Ed25519',
      publicKey: toBase64url(pubKey),
      value: toBase64url(sigBytes),
      signedAt: new Date().toISOString(),
    },
  };

  const zipFiles: Parameters<typeof zipSync>[0] = {};
  for (const [path, bytes] of Object.entries(files)) {
    zipFiles[path] =
      path === 'manifest.json'
        ? [new TextEncoder().encode(JSON.stringify(newManifest, null, 2)), { level: 6 }]
        : [bytes, { level: compressionLevel(path) }];
  }
  return zipSync(zipFiles);
}

/** Sign a `.uix` file on disk, writing the result to `outputPath` (atomic). */
export function sign(uixPath: string, privateKeySeed: Uint8Array, outputPath?: string): void {
  const data = new Uint8Array(readFileSync(uixPath));
  const signed = signBuffer(data, privateKeySeed);
  const dest = outputPath ?? uixPath;
  const tmp = `${dest}.tmp`;
  writeFileSync(tmp, signed);
  renameSync(tmp, dest);
}

export interface VerifyResult {
  valid: boolean;
  /** Ed25519 public key (base64url) embedded in the manifest. */
  publicKey?: string;
  /** ISO-8601 timestamp when the file was signed. */
  signedAt?: string;
  error?: string;
}

/** Verify the Ed25519 signature in a `.uix` buffer. */
export function verifyBuffer(data: Uint8Array): VerifyResult {
  const files = unzipSync(data);
  const rawManifest = files['manifest.json'];
  if (!rawManifest) return { valid: false, error: 'manifest.json not found' };

  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(new TextDecoder().decode(rawManifest)) as Record<string, unknown>;
  } catch {
    return { valid: false, error: 'manifest.json is not valid JSON' };
  }

  const sig = manifest.signature as Record<string, string> | null | undefined;
  if (!sig || typeof sig !== 'object') {
    return { valid: false, error: 'No signature found in manifest' };
  }
  if (sig.algorithm !== 'Ed25519') {
    return {
      valid: false,
      error: `Unsupported algorithm: ${sig.algorithm}`,
    };
  }

  let pubKeyBytes: Uint8Array;
  let sigBytes: Uint8Array;
  try {
    pubKeyBytes = fromBase64url(sig.publicKey);
    sigBytes = fromBase64url(sig.value);
  } catch {
    return { valid: false, error: 'Invalid base64url in signature fields' };
  }

  const { signature: _s, ...manifestWithoutSig } = manifest;
  const payload = buildPayload(files, manifestWithoutSig as Record<string, unknown>);

  try {
    const ok = ed25519.verify(sigBytes, payload, pubKeyBytes);
    if (ok) {
      return { valid: true, publicKey: sig.publicKey, signedAt: sig.signedAt };
    }
    return {
      valid: false,
      error: 'Signature verification failed — file may have been tampered with',
    };
  } catch (err) {
    return {
      valid: false,
      error: `Verification error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** Verify the Ed25519 signature in a `.uix` file on disk. */
export function verify(uixPath: string): VerifyResult {
  const data = new Uint8Array(readFileSync(uixPath));
  return verifyBuffer(data);
}
