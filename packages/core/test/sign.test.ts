import { unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { packBuffer } from '../src/pack.js';
import { generateKeyPair, signBuffer, verifyBuffer } from '../src/sign.js';
import type { Manifest } from '../src/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MANIFEST: Manifest = {
  uix: '1.0',
  id: 'com.test.sign',
  name: 'Sign Test',
  version: '1.0.0',
  entry: 'index.html',
  mode: 'kiosk',
  permissions: [],
  network: 'blocked',
  expires: null,
  state: { seed: false },
};

function makeUix(extra: Record<string, string> = {}): Uint8Array {
  return packBuffer({
    'manifest.json': new TextEncoder().encode(JSON.stringify(MANIFEST)),
    'index.html': new TextEncoder().encode('<html></html>'),
    ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, new TextEncoder().encode(v)])),
  });
}

function tamperZip(
  signed: Uint8Array,
  mutate: (files: Record<string, Uint8Array>) => void,
): Uint8Array {
  const files = unzipSync(signed) as Record<string, Uint8Array>;
  mutate(files);
  return zipSync(
    Object.fromEntries(Object.entries(files).map(([k, v]) => [k, [v, { level: 0 }]])) as Parameters<
      typeof zipSync
    >[0],
  );
}

// ---------------------------------------------------------------------------
// generateKeyPair
// ---------------------------------------------------------------------------

describe('generateKeyPair', () => {
  it('returns base64url strings of correct length', () => {
    const kp = generateKeyPair();
    expect(Buffer.from(kp.privateKey, 'base64url').length).toBe(32);
    expect(Buffer.from(kp.publicKey, 'base64url').length).toBe(32);
  });

  it('generates unique keys each call', () => {
    const a = generateKeyPair();
    const b = generateKeyPair();
    expect(a.privateKey).not.toBe(b.privateKey);
    expect(a.publicKey).not.toBe(b.publicKey);
  });
});

// ---------------------------------------------------------------------------
// signBuffer / verifyBuffer round-trip
// ---------------------------------------------------------------------------

describe('signBuffer / verifyBuffer', () => {
  it('signs and verifies successfully', () => {
    const { privateKey } = generateKeyPair();
    const priv = Buffer.from(privateKey, 'base64url');
    const signed = signBuffer(makeUix(), priv);
    const result = verifyBuffer(signed);
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.signedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('embeds the correct public key in the manifest', () => {
    const { privateKey, publicKey } = generateKeyPair();
    const signed = signBuffer(makeUix(), Buffer.from(privateKey, 'base64url'));
    expect(verifyBuffer(signed).publicKey).toBe(publicKey);
  });

  it('re-signing replaces old signature and verifies with new key', () => {
    const kp1 = generateKeyPair();
    const kp2 = generateKeyPair();
    const signed1 = signBuffer(makeUix(), Buffer.from(kp1.privateKey, 'base64url'));
    const signed2 = signBuffer(signed1, Buffer.from(kp2.privateKey, 'base64url'));
    const result = verifyBuffer(signed2);
    expect(result.valid).toBe(true);
    expect(result.publicKey).toBe(kp2.publicKey);
  });

  it('detects tampered file content', () => {
    const { privateKey } = generateKeyPair();
    const signed = signBuffer(
      makeUix({ 'extra.txt': 'original' }),
      Buffer.from(privateKey, 'base64url'),
    );
    const tampered = tamperZip(signed, (files) => {
      files['extra.txt'] = new TextEncoder().encode('tampered');
    });
    expect(verifyBuffer(tampered).valid).toBe(false);
  });

  it('remains valid after state.db is updated (viewer repack)', () => {
    // state.db is user-owned data — the viewer rewrites it on every close.
    // The signature must stay valid after state.db changes.
    const { privateKey } = generateKeyPair();
    const signed = signBuffer(
      makeUix({ 'state.db': 'seed-state-bytes' }),
      Buffer.from(privateKey, 'base64url'),
    );
    const repacked = tamperZip(signed, (files) => {
      files['state.db'] = new TextEncoder().encode('updated-state-after-user-session');
    });
    expect(verifyBuffer(repacked).valid).toBe(true);
  });

  it('detects tampered manifest (non-signature field)', () => {
    const { privateKey } = generateKeyPair();
    const signed = signBuffer(makeUix(), Buffer.from(privateKey, 'base64url'));
    const tampered = tamperZip(signed, (files) => {
      const m = JSON.parse(new TextDecoder().decode(files['manifest.json']));
      m.name = 'HACKED';
      files['manifest.json'] = new TextEncoder().encode(JSON.stringify(m));
    });
    expect(verifyBuffer(tampered).valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// verifyBuffer error cases
// ---------------------------------------------------------------------------

describe('verifyBuffer error cases', () => {
  it('returns error for unsigned file', () => {
    const result = verifyBuffer(makeUix());
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/no signature/i);
  });

  it('returns error for corrupted signature bytes', () => {
    const { privateKey } = generateKeyPair();
    const signed = signBuffer(makeUix(), Buffer.from(privateKey, 'base64url'));
    const corrupted = tamperZip(signed, (files) => {
      const m = JSON.parse(new TextDecoder().decode(files['manifest.json']));
      m.signature.value = generateKeyPair().publicKey; // random 32-byte b64url
      files['manifest.json'] = new TextEncoder().encode(JSON.stringify(m));
    });
    expect(verifyBuffer(corrupted).valid).toBe(false);
  });
});
