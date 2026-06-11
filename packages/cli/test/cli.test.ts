import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * End-to-end tests for the built CLI binary. They drive the real `dotuix`
 * command as a subprocess, so they exercise arg parsing, command dispatch,
 * and the --json output paths the MCP server depends on.
 */
const CLI = fileURLToPath(new URL('../dist/index.js', import.meta.url));

function run(args: string[], cwd?: string): { stdout: string; code: number } {
  try {
    const stdout = execFileSync('node', [CLI, ...args], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1' },
    });
    return { stdout, code: 0 };
  } catch (err) {
    const e = err as { status?: number; stdout?: string };
    return { stdout: e.stdout ?? '', code: e.status ?? 1 };
  }
}

let dir: string;
let projectDir: string;
let uixPath: string;

beforeAll(() => {
  // Ensure the binary exists (CI builds first; build locally if missing).
  try {
    readFileSync(CLI);
  } catch {
    execFileSync('pnpm', ['build'], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      stdio: 'ignore',
    });
  }

  dir = mkdtempSync(join(tmpdir(), 'dotuix-cli-'));
  projectDir = join(dir, 'app');
  uixPath = join(dir, 'app.uix');

  mkdirSync(projectDir, { recursive: true });
  writeFileSync(
    join(projectDir, 'manifest.json'),
    JSON.stringify({
      uix: '1.0',
      id: 'com.example.clitest',
      name: 'CLI Test',
      version: '1.0.0',
      entry: 'index.html',
      mode: 'window',
      permissions: [],
    }),
  );
  writeFileSync(join(projectDir, 'index.html'), '<html><body>hi</body></html>');
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('dotuix CLI — pack / validate / info', () => {
  it('packs a project directory into a .uix file', () => {
    const { code } = run(['pack', projectDir, '-o', uixPath]);
    expect(code).toBe(0);
    expect(readFileSync(uixPath).byteLength).toBeGreaterThan(0);
  });

  it('validate --json reports a valid file', () => {
    const { stdout } = run(['validate', uixPath, '--json']);
    const result = JSON.parse(stdout) as { valid: boolean; errors: string[] };
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('validate --json reports errors for a broken archive', () => {
    const broken = join(dir, 'broken.uix');
    writeFileSync(broken, 'not a zip');
    const { stdout, code } = run(['validate', broken, '--json']);
    const result = JSON.parse(stdout) as { valid: boolean };
    expect(result.valid).toBe(false);
    expect(code).not.toBe(0);
  });

  it('info --json returns the manifest fields', () => {
    const { stdout } = run(['info', uixPath, '--json']);
    const info = JSON.parse(stdout) as { id: string; name: string; mode: string };
    expect(info.id).toBe('com.example.clitest');
    expect(info.name).toBe('CLI Test');
    expect(info.mode).toBe('window');
  });
});

describe('dotuix CLI — sign / verify roundtrip', () => {
  it('generates a keypair, signs, and verifies', () => {
    const keygen = run(['keygen', '-o', join(dir, 'key')]);
    expect(keygen.code).toBe(0);

    const sign = run(['sign', uixPath, '--key', join(dir, 'key.priv')]);
    expect(sign.code).toBe(0);

    const verify = run(['verify', uixPath]);
    expect(verify.code).toBe(0);
    expect(verify.stdout.toLowerCase()).toMatch(/valid|verified|ok/);
  });
});
