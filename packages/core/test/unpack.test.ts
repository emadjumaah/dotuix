import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pack } from '../src/pack.js';
import { unpack, unpackBuffer } from '../src/unpack.js';

const FIXTURE = join(import.meta.dirname, 'fixtures', 'valid-app');

describe('unpack', () => {
  let tmpDir: string;
  let uixPath: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'dotuix-unpack-'));
    uixPath = join(tmpDir, 'test.uix');
    await pack(FIXTURE, uixPath);
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('extracts manifest.json to the output directory', async () => {
    const outDir = join(tmpDir, 'extracted');
    await unpack(uixPath, outDir);
    expect(existsSync(join(outDir, 'manifest.json'))).toBe(true);
  });

  it('extracts the entry HTML file', async () => {
    const outDir = join(tmpDir, 'extracted2');
    await unpack(uixPath, outDir);
    expect(existsSync(join(outDir, 'index.html'))).toBe(true);
  });

  it('preserves file content through pack → unpack round-trip', async () => {
    const outDir = join(tmpDir, 'roundtrip');
    await unpack(uixPath, outDir);

    const original = readFileSync(join(FIXTURE, 'index.html'), 'utf-8');
    const restored = readFileSync(join(outDir, 'index.html'), 'utf-8');
    expect(restored).toBe(original);
  });

  it('throws on an invalid .uix path', async () => {
    await expect(unpack('/tmp/__no_such_file__.uix', '/tmp/out')).rejects.toThrow();
  });
});

describe('unpackBuffer', () => {
  let buffer: Uint8Array;

  beforeAll(async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'dotuix-buf-'));
    const uixPath = join(tmpDir, 'test.uix');
    await pack(FIXTURE, uixPath);
    buffer = new Uint8Array(readFileSync(uixPath));
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns a file map with manifest.json', () => {
    const files = unpackBuffer(buffer);
    expect(files['manifest.json']).toBeDefined();
  });

  it('returns a file map with index.html', () => {
    const files = unpackBuffer(buffer);
    expect(files['index.html']).toBeDefined();
  });

  it('throws on corrupt data', () => {
    expect(() => unpackBuffer(new Uint8Array([0x00, 0x01, 0x02]))).toThrow();
  });

  it.each([
    '../escape.txt',
    'nested/../../escape.txt',
    '/tmp/escape.txt',
    'C:/escape.txt',
    '..\\escape.txt',
  ])('rejects unsafe archive path %s', (unsafePath) => {
    const archive = zipSync({
      'manifest.json': new TextEncoder().encode('{}'),
      [unsafePath]: new TextEncoder().encode('bad'),
    });

    expect(() => unpackBuffer(archive)).toThrow(/Unsafe archive path/);
  });
});
