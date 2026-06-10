import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pack } from '../src/pack.js';

const FIXTURE = join(import.meta.dirname, 'fixtures', 'valid-app');

describe('pack', () => {
  let tmpDir: string;
  let outPath: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'dotuix-pack-'));
    outPath = join(tmpDir, 'test.uix');
    await pack(FIXTURE, outPath);
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('produces a valid ZIP file', () => {
    const data = new Uint8Array(readFileSync(outPath));
    // ZIP files start with the local file header signature 0x504B0304
    expect(data[0]).toBe(0x50);
    expect(data[1]).toBe(0x4b);
  });

  it('includes manifest.json in archive', () => {
    const data = new Uint8Array(readFileSync(outPath));
    const files = unzipSync(data);
    expect(files['manifest.json']).toBeDefined();
  });

  it('includes the entry file in archive', () => {
    const data = new Uint8Array(readFileSync(outPath));
    const files = unzipSync(data);
    expect(files['index.html']).toBeDefined();
  });

  it('manifest content is preserved correctly', () => {
    const data = new Uint8Array(readFileSync(outPath));
    const files = unzipSync(data);
    const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json']));
    expect(manifest.id).toBe('com.test.validapp');
    expect(manifest.name).toBe('Test App');
    expect(manifest.entry).toBe('index.html');
  });

  it('throws when manifest.json is missing', async () => {
    await expect(pack('/tmp/__no_such_dir__', outPath)).rejects.toThrow('manifest.json');
  });

  it('throws when entry file declared in manifest does not exist', async () => {
    const srcDir = mkdtempSync(join(tmpdir(), 'dotuix-invalid-'));
    writeFileSync(
      join(srcDir, 'manifest.json'),
      JSON.stringify({
        uix: '1.0',
        id: 'com.test.missing',
        name: 'Missing Entry',
        version: '1.0.0',
        entry: 'no-such-file.html',
        mode: 'window',
      }),
    );
    try {
      await expect(pack(srcDir, outPath)).rejects.toThrow('no-such-file.html');
    } finally {
      rmSync(srcDir, { recursive: true, force: true });
    }
  });
});
