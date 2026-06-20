/**
 * @dotuix/cli — dotuix <command> [args]
 *
 * Commands:
 *   pack          <dir> [-o <out>]          Pack a project folder into a .uix file
 *   unpack        <file.uix> [-o <outDir>]  Unpack a .uix file to a directory
 *   validate      <file.uix>                Validate structure + offline-first checks
 *   info          <file.uix>                Print manifest details
 *   init          [name] [-t <template>]    Scaffold a new .uix project
 *   export        <file.uix> --type <t>     Export state records as JSON or CSV
 *   keygen        [-o <base>]               Generate an Ed25519 key pair
 *   sign          <file.uix> --key <k.priv> Sign a .uix file (Ed25519)
 *   verify        <file.uix>                Verify the Ed25519 signature
 *   issue-license --app-id <id>|--from <f.uix> --issued-to <n> --key <k.priv> [opts]
 *   device-id                               Print this device's viewer device ID
 *   build         [project-dir]             Run vite build → pack → .uix
 *   dev           [project-dir]             Start vite dev server with bridge mock
 *   create        <name> [-t <template>]    Scaffold a new Vite-based .uix project
 *   spec          <validate|scaffold|init>  AI spec format helpers
 */

import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { readdirSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import {
  MANIFEST_MODES,
  MANIFEST_PERMISSIONS,
  UIX,
  createDataDb,
  createState,
  generateKeyPair,
  packBuffer,
  publicKeyFromSeed,
  readManifestFromBuffer,
  sign,
  signBytes,
  unpackBuffer,
  verify,
} from '@dotuix/core';
import type { DataRecord, UIXRecord } from '@dotuix/core';

const CLI_VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as {
      version?: string;
    };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

// ---------------------------------------------------------------------------
// ANSI colours (no deps)
// ---------------------------------------------------------------------------
const isTTY = process.stdout.isTTY;
const c = {
  bold: (s: string) => (isTTY ? `\x1b[1m${s}\x1b[0m` : s),
  green: (s: string) => (isTTY ? `\x1b[32m${s}\x1b[0m` : s),
  yellow: (s: string) => (isTTY ? `\x1b[33m${s}\x1b[0m` : s),
  red: (s: string) => (isTTY ? `\x1b[31m${s}\x1b[0m` : s),
  cyan: (s: string) => (isTTY ? `\x1b[36m${s}\x1b[0m` : s),
  muted: (s: string) => (isTTY ? `\x1b[2m${s}\x1b[0m` : s),
};

// ---------------------------------------------------------------------------
// License helpers
// ---------------------------------------------------------------------------

/** Recursively sort object keys for deterministic JSON serialisation (mirrors Rust's sort_json_keys). */
function sortKeysRec(val: unknown): unknown {
  if (Array.isArray(val)) return val.map(sortKeysRec);
  if (val !== null && typeof val === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(val as object).sort())
      out[k] = sortKeysRec((val as Record<string, unknown>)[k]);
    return out;
  }
  return val;
}

/** Return the platform-appropriate path to the viewer's stored device_id file. */
function viewerDeviceIdPath(): string {
  const home = homedir();
  switch (process.platform) {
    case 'darwin':
      return join(home, 'Library', 'Application Support', 'com.dotuix.viewer', 'device_id');
    case 'win32': {
      const appData = process.env.APPDATA ?? join(home, 'AppData', 'Roaming');
      return join(appData, 'com.dotuix.viewer', 'device_id');
    }
    default: {
      const xdg = process.env.XDG_DATA_HOME ?? join(home, '.local', 'share');
      return join(xdg, 'com.dotuix.viewer', 'device_id');
    }
  }
}

// ---------------------------------------------------------------------------
// Offline-first validator — scans text files for external dependencies
// ---------------------------------------------------------------------------
const EXTERNAL_RE = /(?:src|href|url)\s*[=(]["']?(https?:\/\/|\/\/)[^"') >]+/i;
const FETCH_RE = /(?:fetch|XMLHttpRequest)\s*\(\s*["'`](https?:\/\/|\/\/)/i;
const WS_RE = /new\s+WebSocket\s*\(\s*["'`]wss?:\/\//i;
const FONT_RE = /fonts\.googleapis\.com|fonts\.gstatic\.com/i;
const CDN_RE = /cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com|esm\.sh/i;

const TEXT_EXTS = new Set(['html', 'js', 'css', 'ts', 'jsx', 'tsx']);

function offlineCheck(
  files: Record<string, Uint8Array>,
): Array<{ file: string; line: number; message: string }> {
  const issues: Array<{ file: string; line: number; message: string }> = [];
  const dec = new TextDecoder();

  for (const [path, data] of Object.entries(files)) {
    const ext = extname(path).slice(1).toLowerCase();
    if (!TEXT_EXTS.has(ext)) continue;

    const lines = dec.decode(data).split('\n');
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      const num = i + 1;
      if (FONT_RE.test(ln))
        issues.push({
          file: path,
          line: num,
          message: 'Google Fonts import — will fail offline',
        });
      else if (CDN_RE.test(ln))
        issues.push({
          file: path,
          line: num,
          message: 'CDN dependency — will fail offline',
        });
      else if (EXTERNAL_RE.test(ln) || FETCH_RE.test(ln) || WS_RE.test(ln))
        issues.push({
          file: path,
          line: num,
          message: `External URL — will fail offline: ${ln.trim().slice(0, 80)}`,
        });
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Arg parsing helpers (no commander dependency)
// ---------------------------------------------------------------------------
function flag(args: string[], ...flags: string[]): boolean {
  return flags.some((f) => args.includes(f));
}
function opt(args: string[], ...flags: string[]): string | undefined {
  for (const f of flags) {
    const i = args.indexOf(f);
    if (i !== -1 && args[i + 1] && !args[i + 1].startsWith('-')) return args[i + 1];
  }
}
function pos(args: string[]): string[] {
  return args.filter((a, i) => !a.startsWith('-') && (i === 0 || !args[i - 1].startsWith('-')));
}

function atomicWriteFile(targetPath: string, data: Uint8Array): void {
  const tempPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tempPath, data);
    renameSync(tempPath, targetPath);
  } catch (error) {
    try {
      rmSync(tempPath, { force: true });
    } catch {
      // no-op cleanup best effort
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// pack
// ---------------------------------------------------------------------------
async function cmdPack(args: string[]) {
  const dir = pos(args)[0];
  if (!dir) {
    console.error(`${c.red('✗')} Usage: dotuix pack <dir> [-o out.uix]`);
    process.exit(1);
  }
  const absDir = resolve(dir);
  const out = resolve(opt(args, '-o', '--out') ?? `${basename(absDir)}.uix`);
  console.log(c.muted(`Packing ${absDir} …`));
  await UIX.pack(absDir, out);
  const kb = (readFileSync(out).length / 1024).toFixed(1);
  console.log(`${c.green('✓')} ${c.bold(basename(out))}${c.muted(`  ${kb} KB  →  ${out}`)}`);
}

// ---------------------------------------------------------------------------
// unpack
// ---------------------------------------------------------------------------
async function cmdUnpack(args: string[]) {
  const file = pos(args)[0];
  if (!file) {
    console.error(`${c.red('✗')} Usage: dotuix unpack <file.uix> [-o outDir]`);
    process.exit(1);
  }
  const absFile = resolve(file);
  const outDir = resolve(opt(args, '-o', '--out') ?? basename(file, extname(file)));
  console.log(c.muted(`Unpacking ${basename(absFile)} …`));
  await UIX.unpack(absFile, outDir);
  console.log(`${c.green('✓')} Unpacked to ${c.bold(outDir)}`);
}

// ---------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------
async function cmdValidate(args: string[]) {
  const file = pos(args)[0];
  if (!file) {
    console.error(`${c.red('✗')} Usage: dotuix validate <file.uix>`);
    process.exit(1);
  }

  const result = await UIX.validate(resolve(file));

  let offlineIssues: ReturnType<typeof offlineCheck> = [];
  let networkAllowed = false;
  try {
    const data = new Uint8Array(readFileSync(resolve(file)));
    const manifest = readManifestFromBuffer(data);
    networkAllowed = manifest.network === 'allowed';
    if (!networkAllowed) offlineIssues = offlineCheck(unpackBuffer(data));
  } catch {
    /* structural errors captured by validate() */
  }

  const offlineWarnings = offlineIssues.map((i) => `${i.file}:${i.line} — ${i.message}`);

  // Machine-readable mode for programmatic callers (e.g. @dotuix/mcp).
  if (args.includes('--json')) {
    process.stdout.write(
      `${JSON.stringify(
        {
          valid: result.valid,
          errors: result.errors,
          warnings: [...result.warnings, ...offlineWarnings],
        },
        null,
        2,
      )}\n`,
    );
    process.exit(result.valid ? 0 : 1);
  }

  // Print
  if (result.errors.length === 0) {
    console.log(`${c.green('✓')} manifest.json valid`);
    console.log(`${c.green('✓')} entry file present`);
  }
  for (const e of result.errors) console.log(`${c.red('✗')} ${e}`);
  for (const w of result.warnings) console.log(`${c.yellow('⚠')} ${w}`);
  for (const i of offlineIssues) console.log(`${c.yellow('⚠')} ${i.file}:${i.line} — ${i.message}`);

  const warns = result.warnings.length + offlineIssues.length;

  if (!result.valid) {
    console.log(`\n${c.red('✗')} ${result.errors.length} error(s)`);
    process.exit(1);
  } else if (warns > 0) {
    console.log(`\n${c.yellow('⚠')} ${warns} warning(s) — file is valid but check above`);
  } else {
    console.log(`\n${c.green('✓')} ${c.bold(basename(file))} is valid`);
  }
}

// ---------------------------------------------------------------------------
// info
// ---------------------------------------------------------------------------
async function cmdInfo(args: string[]) {
  const file = pos(args)[0];
  if (!file) {
    console.error(`${c.red('✗')} Usage: dotuix info <file.uix>`);
    process.exit(1);
  }

  const data = new Uint8Array(readFileSync(resolve(file)));
  const manifest = readManifestFromBuffer(data);
  const files = unpackBuffer(data);
  const totalBytes = Object.values(files).reduce((s, b) => s + b.length, 0);
  const kb = (totalBytes / 1024).toFixed(1);

  // Machine-readable mode for programmatic callers (e.g. @dotuix/mcp).
  if (args.includes('--json')) {
    process.stdout.write(
      `${JSON.stringify(
        {
          name: manifest.name,
          version: manifest.version,
          id: manifest.id,
          uix: manifest.uix,
          mode: manifest.mode,
          network: manifest.network ?? 'blocked',
          entry: manifest.entry,
          permissions: manifest.permissions ?? [],
          expires: manifest.expires ?? null,
          author: manifest.author ?? null,
          fileCount: Object.keys(files).length,
          uncompressedBytes: totalBytes,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  console.log(`\n  ${c.bold(manifest.name)}  ${c.muted(`v${manifest.version}`)}`);
  console.log(`  ${c.muted('id:')}          ${manifest.id}`);
  console.log(`  ${c.muted('format:')}      uix ${manifest.uix}`);
  console.log(`  ${c.muted('mode:')}        ${manifest.mode}`);
  console.log(`  ${c.muted('network:')}     ${manifest.network ?? 'blocked'}`);
  console.log(`  ${c.muted('entry:')}       ${manifest.entry}`);
  if (manifest.permissions?.length)
    console.log(`  ${c.muted('permissions:')} ${manifest.permissions.join(', ')}`);
  if (manifest.expires) {
    const expired = new Date(manifest.expires) < new Date();
    console.log(
      `  ${c.muted('expires:')}     ${manifest.expires}${expired ? c.red(' (expired)') : c.green(' (active)')}`,
    );
  }
  if (manifest.author) {
    console.log(`  ${c.muted('author:')}      ${manifest.author}`);
  }
  console.log(`  ${c.muted('files:')}       ${Object.keys(files).length} (${kb} KB uncompressed)`);
  console.log();
}

// ---------------------------------------------------------------------------
// export
// ---------------------------------------------------------------------------
async function cmdExport(args: string[]) {
  const file = pos(args)[0];
  const outFile = opt(args, '--output', '-o');
  const typesStr = opt(args, '--types');
  const isBundleMode = typesStr !== undefined || outFile?.endsWith('.uixdata');

  // ── .uixdata bundle mode ──────────────────────────────────────────────────
  if (isBundleMode) {
    if (!file) {
      console.error(
        `${c.red('✗')} Usage: dotuix export <file.uix> [--types t1,t2] --output bundle.uixdata`,
      );
      process.exit(1);
    }
    const types = typesStr
      ? typesStr
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean)
      : [];
    const output = outFile ?? `${basename(file, '.uix')}.uixdata`;

    const data = new Uint8Array(readFileSync(resolve(file)));
    const bFiles = unpackBuffer(data);
    const manifest = readManifestFromBuffer(data);

    const stateDb = await createState({
      uixVersion: manifest.uix,
      seed: bFiles['state.db'],
      permissions: ['raw-sql'],
    });
    const records: UIXRecord[] =
      types.length > 0
        ? types.flatMap((t) => stateDb.find({ type: t }))
        : // raw() selects exactly the record columns, so the rows are UIXRecords.
          (stateDb.raw(
            'SELECT id, type, body, created_at, updated_at FROM records ORDER BY created_at',
            [],
          ) as unknown as UIXRecord[]);
    stateDb.close();

    const checksum = `sha256:${createHash('sha256').update(JSON.stringify(records)).digest('hex')}`;
    const uniqueTypes = [...new Set(records.map((r) => r.type))];
    const rawSchemaVersion = Reflect.get(manifest as object, 'schemaVersion');
    const schemaVersion =
      typeof rawSchemaVersion === 'number' &&
      Number.isFinite(rawSchemaVersion) &&
      rawSchemaVersion > 0
        ? Math.trunc(rawSchemaVersion)
        : 1;
    const bundle = {
      format: 'uixdata/1.0',
      appId: manifest.id,
      schemaVersion,
      exportedAt: new Date().toISOString(),
      exportedBy: `dotuix-cli/${CLI_VERSION}`,
      checksum,
      types: uniqueTypes,
      records,
    };
    writeFileSync(resolve(output), JSON.stringify(bundle, null, 2), 'utf8');
    console.log(`${c.green('✓')} ${records.length} record(s) → ${c.bold(output)}`);
    if (uniqueTypes.length > 0) console.log(c.muted(`  types: ${uniqueTypes.join(', ')}`));
    return;
  }

  // ── Legacy single-type CSV/JSON export ────────────────────────────────────
  const type = opt(args, '--type', '-t');
  const format = (opt(args, '--format', '-f') ?? 'json').toLowerCase();

  if (!file || !type) {
    console.error(
      `${c.red('✗')} Usage: dotuix export <file.uix> --type <type> [--format json|csv] [-o file]`,
    );
    process.exit(1);
  }
  if (format !== 'json' && format !== 'csv') {
    console.error(`${c.red('✗')} --format must be json or csv`);
    process.exit(1);
  }

  const data = new Uint8Array(readFileSync(resolve(file)));
  const files = unpackBuffer(data);
  const manifest = readManifestFromBuffer(data);

  const stateDb = await createState({
    uixVersion: manifest.uix,
    seed: files['state.db'],
    permissions: ['raw-sql'],
  });
  const records = stateDb.find({ type });
  stateDb.close();

  if (records.length === 0) {
    console.log(`${c.yellow('⚠')} No records of type "${type}" found in state.db`);
    return;
  }

  const rows = records.map((r: UIXRecord) => {
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(r.body as string);
    } catch {
      body = { raw: r.body };
    }
    return {
      id: r.id,
      type: r.type,
      created_at: r.created_at,
      updated_at: r.updated_at,
      ...body,
    };
  });

  let content: string;
  if (format === 'json') {
    content = JSON.stringify(rows, null, 2);
  } else {
    const keys = Array.from(new Set(rows.flatMap((r) => Object.keys(r))));
    const esc = (v: unknown) => {
      const s = v == null ? '' : String(v);
      return s.includes(',') || s.includes('"') || s.includes('\n')
        ? `"${s.replace(/"/g, '""')}"`
        : s;
    };
    content = [
      keys.join(','),
      ...rows.map((r) => keys.map((k) => esc((r as Record<string, unknown>)[k])).join(',')),
    ].join('\n');
  }

  if (outFile) {
    writeFileSync(resolve(outFile), content, 'utf8');
    console.log(`${c.green('✓')} ${rows.length} record(s) → ${outFile}`);
  } else {
    console.log(content);
  }
}

// ---------------------------------------------------------------------------
// import
// ---------------------------------------------------------------------------
async function cmdImport(args: string[]) {
  const file = pos(args)[0];
  const dataFile = opt(args, '--data', '-d');
  const merge = flag(args, '--merge');

  if (!file || !dataFile) {
    console.error(
      `${c.red('✗')} Usage: dotuix import <file.uix> --data <bundle.uixdata> [--merge]`,
    );
    process.exit(1);
  }

  // 1. Read + parse bundle
  let bundleRaw: string;
  try {
    bundleRaw = readFileSync(resolve(dataFile), 'utf8');
  } catch {
    console.error(`${c.red('✗')} Cannot read bundle: ${dataFile}`);
    process.exit(1);
    return;
  }
  let bundle: {
    format: string;
    appId?: string;
    schemaVersion?: number;
    checksum?: string;
    records: UIXRecord[];
  };
  try {
    bundle = JSON.parse(bundleRaw);
  } catch {
    console.error(`${c.red('✗')} Invalid JSON in bundle file`);
    process.exit(1);
    return;
  }
  if (bundle.format !== 'uixdata/1.0') {
    console.error(`${c.red('✗')} Unsupported bundle format: "${bundle.format}"`);
    process.exit(1);
  }
  if (!Array.isArray(bundle.records)) {
    console.error(`${c.red('✗')} Bundle has no records array`);
    process.exit(1);
  }

  // 2. Verify checksum
  if (bundle.checksum) {
    const expected = `sha256:${createHash('sha256').update(JSON.stringify(bundle.records)).digest('hex')}`;
    if (bundle.checksum !== expected) {
      console.error(`${c.red('✗')} Checksum mismatch — bundle may be corrupted or tampered with`);
      process.exit(1);
    }
  } else {
    console.log(`${c.yellow('⚠')} No checksum in bundle — skipping integrity check`);
  }

  // 3. Open target .uix
  const uixPath = resolve(file);
  let uixData: Uint8Array;
  try {
    uixData = new Uint8Array(readFileSync(uixPath));
  } catch {
    console.error(`${c.red('✗')} Cannot read .uix file: ${file}`);
    process.exit(1);
    return;
  }
  const iFiles = unpackBuffer(uixData);
  const iManifest = readManifestFromBuffer(uixData);

  if (bundle.appId && bundle.appId !== iManifest.id) {
    console.log(
      `${c.yellow('⚠')} Bundle appId "${bundle.appId}" differs from target "${iManifest.id}"`,
    );
  }

  const stateDb = await createState({
    uixVersion: iManifest.uix,
    seed: iFiles['state.db'],
    permissions: ['raw-sql'],
  });

  // 4. Import records
  let imported = 0;
  let skipped = 0;

  if (!merge) {
    // Replace mode: clear matching types first
    const types = [...new Set(bundle.records.map((r) => r.type))];
    for (const t of types) {
      stateDb.raw('DELETE FROM records WHERE type = ?', [t]);
    }
  }

  for (const rec of bundle.records) {
    const body = typeof rec.body === 'string' ? rec.body : JSON.stringify(rec.body);
    if (merge && stateDb.get(rec.id) !== null) {
      skipped++;
      continue;
    }
    stateDb.raw(
      'INSERT OR IGNORE INTO records (id, type, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      [rec.id, rec.type, body, rec.created_at, rec.updated_at],
    );
    imported++;
  }

  // 5. Repack .uix
  const newStateDb = stateDb.serialize();
  stateDb.close();

  const updatedFiles = { ...iFiles, 'state.db': newStateDb };
  const packed = packBuffer(updatedFiles);
  atomicWriteFile(uixPath, packed);

  console.log(
    `${c.green('✓')} Imported ${c.bold(String(imported))} record(s) into ${c.bold(basename(file))}`,
  );
  if (skipped > 0) console.log(c.muted(`  ${skipped} skipped (already exists)`));
}

// ---------------------------------------------------------------------------
// inspect-data
// ---------------------------------------------------------------------------
async function cmdInspectData(args: string[]) {
  const file = pos(args)[0];
  if (!file) {
    console.error(`${c.red('✗')} Usage: dotuix inspect-data <bundle.uixdata>`);
    process.exit(1);
  }

  let bundleRaw: string;
  try {
    bundleRaw = readFileSync(resolve(file), 'utf8');
  } catch {
    console.error(`${c.red('✗')} Cannot read file: ${file}`);
    process.exit(1);
    return;
  }
  let bundle: Record<string, unknown>;
  try {
    bundle = JSON.parse(bundleRaw);
  } catch {
    console.error(`${c.red('✗')} Invalid JSON`);
    process.exit(1);
    return;
  }

  if ((bundle.format as string) !== 'uixdata/1.0') {
    console.error(`${c.red('✗')} Unsupported bundle format: "${bundle.format}"`);
    process.exit(1);
  }

  const records = (bundle.records as UIXRecord[]) ?? [];

  // Verify checksum
  let checksumStatus = c.muted('(none)');
  let checksumOk = true;
  if (bundle.checksum) {
    const expected = `sha256:${createHash('sha256').update(JSON.stringify(records)).digest('hex')}`;
    checksumOk = bundle.checksum === expected;
    const short = `${(bundle.checksum as string).slice(0, 16)}\u2026`;
    checksumStatus = checksumOk
      ? `${c.green('✓')} ${c.muted(short)}`
      : `${c.red('✗')} ${c.red('MISMATCH')} ${c.muted(short)}`;
  }

  // Count by type
  const countByType: Record<string, number> = {};
  for (const r of records) {
    countByType[r.type] = (countByType[r.type] ?? 0) + 1;
  }

  console.log(`\n  ${c.bold(basename(file))}`);
  console.log(`  ${c.muted('format:')}     ${bundle.format}`);
  console.log(`  ${c.muted('appId:')}      ${bundle.appId ?? c.muted('(none)')}`);
  console.log(`  ${c.muted('schema:')}     v${bundle.schemaVersion ?? 1}`);
  console.log(`  ${c.muted('exported:')}   ${bundle.exportedAt ?? c.muted('(unknown)')}`);
  console.log(`  ${c.muted('by:')}         ${bundle.exportedBy ?? c.muted('(unknown)')}`);
  console.log(`  ${c.muted('checksum:')}   ${checksumStatus}`);
  console.log(`  ${c.muted('records:')}    ${records.length} total`);
  if (Object.keys(countByType).length > 0) {
    console.log();
    for (const [type, count] of Object.entries(countByType)) {
      console.log(`    ${c.cyan(type)}  ${c.muted(String(count))}`);
    }
  }
  console.log();

  if (!checksumOk) process.exit(1);
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------
const SCAFFOLD: Record<string, string> = {
  'manifest.json': `{
  "uix": "1.0",
  "id": "com.example.SLUG",
  "name": "NAME",
  "version": "1.0.0",
  "entry": "index.html",
  "mode": "kiosk",
  "permissions": ["local-storage"],
  "network": "blocked",
  "state": { "seed": false },
  "theme": { "color": "#c8a96e", "background": "#1a1a1a" }
}`,
  'index.html': `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>NAME</title>
    <link rel="stylesheet" href="style.css" />
  </head>
  <body>
    <h1>NAME</h1>
    <p id="status">Ready.</p>
    <script src="app.js"></script>
  </body>
</html>`,
  'style.css': `*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: system-ui, sans-serif; background: #1a1a1a; color: #e8e8e8; padding: 2rem; }
h1   { color: #c8a96e; margin-bottom: 1rem; }
`,
  'app.js': `/**
 * app.js
 *
 * window.__uix is injected by the dotuix viewer:
 *   __uix.data.find({ type, where?, orderBy?, limit? })
 *   __uix.data.get(id)
 *   __uix.state.find / get / insert / update / delete
 *   __uix.manifest
 */
const bridge = window.__uix ?? null;

async function main() {
  const name = bridge?.manifest()?.name ?? "NAME";
  document.querySelector("h1").textContent = name;
  document.getElementById("status").textContent = "Edit app.js to build your experience.";
}

main().catch(console.error);
`,
};

const KNOWN_TEMPLATES = ['restaurant', 'catalog', 'portfolio'] as const;
type TemplateName = (typeof KNOWN_TEMPLATES)[number];

async function cmdInit(args: string[]) {
  const templateArg = opt(args, '-t', '--template') as TemplateName | null;
  const name = pos(args)[0] ?? templateArg ?? 'my-uix-app';
  const dir = resolve(name);
  const slug = basename(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');

  if (existsSync(dir)) {
    console.error(`${c.red('✗')} Already exists: ${dir}`);
    process.exit(1);
  }
  mkdirSync(dir, { recursive: true });

  if (templateArg) {
    // ── Scaffold from a bundled starter template ────────────────────────
    if (!KNOWN_TEMPLATES.includes(templateArg)) {
      console.error(
        `${c.red('✗')} Unknown template "${templateArg}". Available: ${KNOWN_TEMPLATES.join(', ')}`,
      );
      process.exit(1);
    }
    const tmplDir = join(__dirname, 'templates', templateArg);
    if (!existsSync(tmplDir)) {
      console.error(
        `${c.red('✗')} Template files not found at ${tmplDir}.\n  Run ${c.cyan('pnpm --filter @dotuix/cli build')} to rebuild the CLI.`,
      );
      process.exit(1);
    }
    cpSync(tmplDir, dir, { recursive: true });

    // Patch manifest id + name
    const manifestPath = join(dir, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.id = `com.example.${slug}`;
    manifest.name = basename(name);
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

    const files = readdirSync(dir);
    console.log(
      `\n  ${c.green('✓')} Created ${c.bold(name)}/ from template ${c.cyan(templateArg)}\n`,
    );
    for (const f of files) console.log(`    ${c.muted('+')} ${f}`);
  } else {
    // ── Minimal blank scaffold ───────────────────────────────────────────
    for (const [filename, tpl] of Object.entries(SCAFFOLD)) {
      const content = tpl.replace(/NAME/g, basename(name)).replace(/SLUG/g, slug);
      writeFileSync(join(dir, filename), content, 'utf8');
    }
    console.log(`\n  ${c.green('✓')} Created ${c.bold(name)}/\n`);
    for (const f of Object.keys(SCAFFOLD)) console.log(`    ${c.muted('+')} ${f}`);
  }

  console.log(`
  Next:

    ${c.cyan('cd')} ${name}
    ${c.cyan('dotuix pack')} .
    ${c.cyan('dotuix validate')} ${slug}.uix
`);
}

// ---------------------------------------------------------------------------
// keygen
// ---------------------------------------------------------------------------
function cmdKeygen(args: string[]) {
  const base = (opt(args, '-o', '--out') ?? pos(args)[0] ?? 'dotuix-key').replace(
    /\.(priv|pub)$/,
    '',
  );
  const privPath = resolve(`${base}.priv`);
  const pubPath = resolve(`${base}.pub`);

  if (existsSync(privPath) || existsSync(pubPath)) {
    console.error(`${c.red('✗')} Key files already exist: ${base}.priv / ${base}.pub`);
    process.exit(1);
  }

  const kp = generateKeyPair();
  // The private key is the Ed25519 signing seed — write it owner-read/write
  // only (0600) so a leaked key cannot forge .uix signatures or licenses.
  writeFileSync(privPath, kp.privateKey, { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(privPath, 0o600); // enforce even if a prior umask widened it
  } catch {
    /* non-POSIX (e.g. Windows) — best effort */
  }
  writeFileSync(pubPath, kp.publicKey, 'utf8');

  console.log(`
  ${c.green('✓')} Key pair generated
`);
  console.log(`  ${c.muted('private:')} ${privPath}`);
  console.log(`  ${c.muted('public:')}  ${pubPath}`);
  console.log(`
  ${c.yellow('⚠')} Keep ${basename(privPath)} secret — never share it.\n`);
}

// ---------------------------------------------------------------------------
// sign
// ---------------------------------------------------------------------------
async function cmdSign(args: string[]) {
  const file = pos(args)[0];
  const keyFile = opt(args, '--key', '-k');
  if (!file || !keyFile) {
    console.error(`${c.red('✗')} Usage: dotuix sign <file.uix> --key <keyfile.priv> [-o out.uix]`);
    process.exit(1);
  }

  const absFile = resolve(file);
  const out = resolve(opt(args, '-o', '--out') ?? absFile);

  const privKeyStr = readFileSync(resolve(keyFile), 'utf8').trim();
  const privKeyBytes = Buffer.from(privKeyStr, 'base64url');
  if (privKeyBytes.length !== 32) {
    console.error(
      `${c.red('✗')} Key file does not contain a valid 32-byte Ed25519 private key seed`,
    );
    process.exit(1);
  }

  console.log(c.muted(`Signing ${basename(absFile)} …`));
  sign(absFile, privKeyBytes, out);
  console.log(`${c.green('✓')} Signed ${c.bold(basename(out))}`);
}

// ---------------------------------------------------------------------------
// encrypt
// ---------------------------------------------------------------------------
async function cmdEncrypt(args: string[]) {
  const file = pos(args)[0];
  const pin = opt(args, '--pin', '-p');
  const out = opt(args, '-o', '--out');
  const pathsArg = opt(args, '--paths');

  if (!file || !pin) {
    console.error(
      `${c.red('✗')} Usage: dotuix encrypt <file.uix> --pin <PIN> [--paths a,b,...] [-o out.uix]`,
    );
    process.exit(1);
  }

  const { createCipheriv, pbkdf2Sync, randomBytes } = await import('node:crypto');
  const absFile = resolve(file);
  const outFile = resolve(out ?? absFile);

  const raw = new Uint8Array(readFileSync(absFile));
  const files = unpackBuffer(raw) as Record<string, Uint8Array>;

  const manifestStr = new TextDecoder().decode(files['manifest.json']);
  if (!manifestStr) {
    console.error(`${c.red('✗')} manifest.json not found in archive`);
    process.exit(1);
  }
  const manifest = JSON.parse(manifestStr) as Record<string, unknown>;

  // Determine which paths to encrypt.
  const allPaths = Object.keys(files);
  let encryptedPaths: string[];
  if (pathsArg) {
    encryptedPaths = pathsArg
      .split(',')
      .map((s) => s.trim())
      .filter((p) => allPaths.includes(p));
  } else {
    encryptedPaths = allPaths.filter(
      (p) => p !== 'manifest.json' && p !== 'state.db' && p !== 'data.db',
    );
  }

  if (encryptedPaths.length === 0) {
    console.error(`${c.red('✗')} No paths matched for encryption`);
    process.exit(1);
  }

  // Key derivation.
  const salt = randomBytes(32);
  const iterations = 200_000;
  const key = pbkdf2Sync(pin, salt, iterations, 32, 'sha256');

  // Encrypt each file: [12-byte nonce][ciphertext+GCM tag]
  console.log(c.muted(`Encrypting ${encryptedPaths.length} file(s) in ${basename(absFile)} …`));
  for (const p of encryptedPaths) {
    const plaintext = Buffer.from(files[p]!);
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    const encrypted = Buffer.concat([
      cipher.update(plaintext),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    files[p] = new Uint8Array(Buffer.concat([nonce, encrypted]));
  }

  // Update manifest with security block.
  manifest.security = {
    ...((manifest.security as object) ?? {}),
    auth: 'pin',
    kdf: 'PBKDF2-SHA256',
    kdfIterations: iterations,
    keySalt: salt.toString('base64url'),
    encryptedPaths,
  };
  files['manifest.json'] = new TextEncoder().encode(JSON.stringify(manifest, null, 2));

  const packed = packBuffer(files as Record<string, Uint8Array>);
  atomicWriteFile(outFile, packed);
  console.log(`${c.green('✓')} Encrypted ${c.bold(outFile)}`);
  console.log(`  ${c.muted('paths:')} ${encryptedPaths.length} file(s) encrypted`);
  console.log(`  ${c.muted('auth:')}  PIN (PBKDF2-SHA256, ${iterations} iterations)`);
  console.log(`\n  ${c.yellow('⚠')} The PIN is not stored — share it separately.\n`);
}

// ---------------------------------------------------------------------------
// verify
// ---------------------------------------------------------------------------
async function cmdVerify(args: string[]) {
  const file = pos(args)[0];
  if (!file) {
    console.error(`${c.red('✗')} Usage: dotuix verify <file.uix>`);
    process.exit(1);
  }

  const result = verify(resolve(file));

  if (result.valid) {
    console.log(`${c.green('✓')} Signature valid`);
    console.log(`  ${c.muted('algorithm:')} Ed25519`);
    console.log(`  ${c.muted('publicKey:')} ${result.publicKey}`);
    if (result.signedAt) console.log(`  ${c.muted('signedAt:')}  ${result.signedAt}`);
  } else {
    console.error(`${c.red('✗')} ${result.error ?? 'Verification failed'}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// seed — create data.db from a JSON records file
// ---------------------------------------------------------------------------
async function cmdSeed(args: string[]) {
  const positional = pos(args);
  const input = positional[0];
  if (!input) {
    console.error(
      `${c.red('✗')} Usage: dotuix seed <records.json> [-o data.db]\n  records.json must be a JSON array of { id?, type, body } objects.`,
    );
    process.exit(1);
  }
  const inputPath = resolve(input);
  if (!existsSync(inputPath)) {
    console.error(`${c.red('✗')} File not found: ${inputPath}`);
    process.exit(1);
  }

  let records: DataRecord[];
  try {
    records = JSON.parse(readFileSync(inputPath, 'utf8'));
    if (!Array.isArray(records)) throw new Error('Root value must be a JSON array');
  } catch (e) {
    console.error(`${c.red('✗')} Invalid JSON in ${input}: ${(e as Error).message}`);
    process.exit(1);
  }

  const outPath = resolve(opt(args, '-o', '--output') ?? 'data.db');
  const bytes = await createDataDb(records);
  writeFileSync(outPath, bytes);
  console.log(
    `${c.green('✓')} Seeded ${c.bold(String(records.length))} records → ${c.cyan(outPath)}`,
  );
}

// ---------------------------------------------------------------------------
// device-id — print the dotuix viewer's device ID for this machine
// ---------------------------------------------------------------------------
function cmdDeviceId(_args: string[]) {
  const idPath = viewerDeviceIdPath();
  if (!existsSync(idPath)) {
    console.error(
      `${c.red('✗')} No device ID found — launch the dotuix viewer on this machine first.\n${c.muted(`  Expected: ${idPath}`)}`,
    );
    process.exit(1);
  }
  const id = readFileSync(idPath, 'utf8').trim();
  if (!id) {
    console.error(`${c.red('✗')} Device ID file is empty.`);
    process.exit(1);
  }
  console.log(`\n  ${c.bold('Device ID')}\n`);
  console.log(`  ${c.cyan(id)}\n`);
  console.log(c.muted('  Share this with the app publisher to receive a license.\n'));
}

// ---------------------------------------------------------------------------
// issue-license — create and sign a .uixlicense token
// ---------------------------------------------------------------------------
async function cmdIssueLicense(args: string[]) {
  const appIdArg = opt(args, '--app-id');
  const fromArg = opt(args, '--from');
  const issuedTo = opt(args, '--issued-to');
  const expiresAt = opt(args, '--expires');
  const deviceId = opt(args, '--device-id');
  const featuresArg = opt(args, '--features');
  const maxDevicesArg = opt(args, '--max-devices');
  const keyFile = opt(args, '--key', '-k');
  const outArg = opt(args, '-o', '--out');

  if (!issuedTo || !keyFile || (!appIdArg && !fromArg)) {
    console.error(
      `${c.red('✗')} Usage: dotuix issue-license (--app-id <id> | --from <file.uix>)\n                          --issued-to <name> --key <k.priv>\n                          [--expires YYYY-MM-DD] [--device-id <uuid>]\n                          [--features f1,f2] [--max-devices N]\n                          [-o out.uixlicense]\n`,
    );
    process.exit(1);
  }

  // Resolve appId — either direct or from a .uix manifest
  let appId = appIdArg;
  if (!appId && fromArg) {
    const uixData = new Uint8Array(readFileSync(resolve(fromArg)));
    appId = readManifestFromBuffer(uixData).id;
  }
  if (!appId) {
    console.error(`${c.red('✗')} Provide --app-id or --from <file.uix>`);
    process.exit(1);
  }

  // Validate --expires format
  if (expiresAt && !/^\d{4}-\d{2}-\d{2}$/.test(expiresAt)) {
    console.error(`${c.red('✗')} --expires must be YYYY-MM-DD (e.g. 2027-05-21)`);
    process.exit(1);
  }

  // Read + validate private key (32-byte Ed25519 seed, base64url-encoded)
  let privKey: Uint8Array;
  try {
    const raw = readFileSync(resolve(keyFile), 'utf8').trim();
    privKey = new Uint8Array(Buffer.from(raw, 'base64url'));
  } catch {
    console.error(`${c.red('✗')} Cannot read key file: ${keyFile}`);
    process.exit(1);
  }
  if (privKey.length !== 32) {
    console.error(
      `${c.red('✗')} Key file does not contain a valid 32-byte Ed25519 private-key seed`,
    );
    process.exit(1);
  }

  const features = featuresArg
    ? featuresArg
        .split(',')
        .map((f) => f.trim())
        .filter(Boolean)
    : [];
  const maxDevices = maxDevicesArg !== undefined ? Number.parseInt(maxDevicesArg, 10) : undefined;

  const today = new Date().toISOString().split('T')[0];

  // Build payload — omit optional fields when absent so the canonical JSON
  // exactly matches what Rust produces from the deserialized struct
  // (skip_serializing_if = "Option::is_none" on expiresAt / maxDevices / deviceId).
  interface LicensePayload {
    appId: string;
    issuedTo: string;
    issuedAt: string;
    features: string[];
    expiresAt?: string;
    maxDevices?: number;
    deviceId?: string;
  }
  const payload: LicensePayload = {
    appId,
    issuedTo,
    issuedAt: today,
    features,
  };
  if (expiresAt) payload.expiresAt = expiresAt;
  if (maxDevices !== undefined && !Number.isNaN(maxDevices)) payload.maxDevices = maxDevices;
  if (deviceId !== undefined) payload.deviceId = deviceId;

  // Canonical JSON — sorted keys mirror Rust's sort_json_keys
  const payloadCanon = JSON.stringify(sortKeysRec(payload));
  const msg = new TextEncoder().encode(`DOTUIX-LICENSE-V1\n${payloadCanon}`);

  const sigBytes = signBytes(msg, privKey);
  const signature = Buffer.from(sigBytes).toString('base64url');

  // Write .uixlicense file
  const license = { payload, signature };
  const slug = issuedTo
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const outPath = resolve(outArg ?? `${slug}.uixlicense`);
  writeFileSync(outPath, JSON.stringify(license, null, 2), 'utf8');

  // Derive public key for convenience display
  const pubKey = `ed25519:${publicKeyFromSeed(privKey)}`;

  console.log(`\n  ${c.green('✓')} License issued\n`);
  console.log(`  ${c.muted('file:')}       ${outPath}`);
  console.log(`  ${c.muted('appId:')}      ${appId}`);
  console.log(`  ${c.muted('issuedTo:')}   ${issuedTo}`);
  console.log(`  ${c.muted('issuedAt:')}   ${today}`);
  if (expiresAt) console.log(`  ${c.muted('expiresAt:')}  ${expiresAt}`);
  if (features.length > 0) console.log(`  ${c.muted('features:')}   ${features.join(', ')}`);
  if (maxDevices !== undefined) console.log(`  ${c.muted('maxDevices:')} ${maxDevices}`);
  if (deviceId) console.log(`  ${c.muted('deviceId:')}   ${deviceId}`);
  console.log(`  ${c.muted('publicKey:')}  ${pubKey}`);
  console.log(`
  ${c.muted('Tip: add this to your manifest to enable license enforcement:')}
  ${c.muted(`  "license": { "required": true, "publisherKey": "${pubKey}" }`)}
`);
}

// ---------------------------------------------------------------------------
// create — Vite project scaffolding
// ---------------------------------------------------------------------------

const VITE_TEMPLATES = ['vanilla-ts', 'react-ts', 'vue-ts', 'form', 'report'] as const;
type ViteTemplateName = (typeof VITE_TEMPLATES)[number];

async function cmdCreate(args: string[]) {
  const templateArg = (opt(args, '-t', '--template') ?? 'vanilla-ts') as ViteTemplateName;
  const name = pos(args)[0] ?? 'my-uix-app';
  const dir = resolve(name);
  const slug = basename(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const displayName = basename(name);

  if (!VITE_TEMPLATES.includes(templateArg)) {
    console.error(
      `${c.red('✗')} Unknown template "${templateArg}". Available: ${VITE_TEMPLATES.join(', ')}`,
    );
    process.exit(1);
  }

  if (existsSync(dir)) {
    console.error(`${c.red('✗')} Already exists: ${dir}`);
    process.exit(1);
  }

  const tmplDir = join(__dirname, 'templates', templateArg);
  if (!existsSync(tmplDir)) {
    console.error(
      `${c.red('✗')} Template files not found at ${tmplDir}.\n  Run ${c.cyan('pnpm --filter @dotuix/cli build')} to rebuild the CLI.`,
    );
    process.exit(1);
  }

  cpSync(tmplDir, dir, { recursive: true });

  // Patch __SLUG__ / __NAME__ placeholders in all text files
  const TEXT_EXTS = new Set(['.ts', '.tsx', '.vue', '.json', '.html', '.css', '.md']);
  const allFiles = readdirSync(dir, { recursive: true }) as string[];
  for (const rel of allFiles) {
    const abs = join(dir, rel);
    if (statSync(abs).isDirectory()) continue;
    if (!TEXT_EXTS.has(extname(abs))) continue;
    const src = readFileSync(abs, 'utf8');
    if (!src.includes('__SLUG__') && !src.includes('__NAME__')) continue;
    writeFileSync(abs, src.replace(/__SLUG__/g, slug).replace(/__NAME__/g, displayName), 'utf8');
  }

  const created = (readdirSync(dir, { recursive: true }) as string[]).filter(
    (f) => !statSync(join(dir, f)).isDirectory(),
  );
  console.log(
    `\n  ${c.green('✓')} Created ${c.bold(name)}/ from template ${c.cyan(templateArg)}\n`,
  );
  for (const f of created) console.log(`    ${c.muted('+')} ${f}`);

  console.log(`
  Next:

    ${c.cyan('cd')} ${name}
    ${c.cyan('pnpm install')}
    ${c.cyan('pnpm dev')}       ${c.muted('# hot-reload dev server with uix bridge mock')}

  When ready to build:

    ${c.cyan('pnpm build')}     ${c.muted(`# → dist/ → ${slug}.uix`)}
`);
}

// ---------------------------------------------------------------------------
// spec — AI spec format: init, validate, scaffold
// ---------------------------------------------------------------------------

interface AppSpec {
  identity: {
    id?: string;
    name?: string;
    mode?: string;
    state?: string;
    schemaVersion?: number;
    framework?: string;
  };
  dataModel: Array<{ type: string; fields: string[] }>;
  screens: string[];
  permissions: string[];
  theme: { color?: string; background?: string };
  seedData: string[];
}

function specSection(md: string, heading: string): string {
  const esc = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`##\\s+${esc}[^\\n]*\\n([\\s\\S]*?)(?=\\n##\\s|$)`, 'i');
  return (re.exec(md)?.[1] ?? '').trim();
}

function parseKV(text: string): Record<string, string> {
  const kv: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^[-*]\s+([\w][\w /-]*):\s*(.+)/);
    if (m) kv[m[1].trim().toLowerCase().replace(/\s+/g, '-')] = m[2].split('#')[0].trim();
  }
  return kv;
}

function parseList(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.replace(/^\s*(?:[-*]|\d+\.)\s+/, '').trim())
    .filter((l) => l.length > 0);
}

function parseTable(text: string): Array<{ type: string; fields: string[] }> {
  const rows: Array<{ type: string; fields: string[] }> = [];
  for (const line of text.split('\n')) {
    if (!line.includes('|')) continue;
    const cols = line
      .split('|')
      .map((c) => c.trim())
      .filter(Boolean);
    if (cols.length < 2 || /type/i.test(cols[0]) || /^[-|: ]+$/.test(cols[0])) continue;
    rows.push({
      type: cols[0],
      fields: cols[1]
        .split(/[,;]/)
        .map((f) => f.trim())
        .filter(Boolean),
    });
  }
  return rows;
}

function parseSpec(md: string): AppSpec {
  const id = parseKV(specSection(md, 'Identity'));
  return {
    identity: {
      id: id.id,
      name: id.name,
      mode: id.mode,
      state: id.state,
      schemaVersion: id.schemaversion ? Number(id.schemaversion) : undefined,
      framework: id.framework,
    },
    dataModel: parseTable(specSection(md, 'Data Model')),
    screens: parseList(specSection(md, 'Screens')),
    permissions: parseList(specSection(md, 'Permissions')),
    theme: parseKV(specSection(md, 'Theme')),
    seedData: parseList(specSection(md, 'Seed Data')),
  };
}

function validateSpec(spec: AppSpec): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!spec.identity.id) errors.push('Identity.id is required  (e.g.  - id: com.example.my-app)');
  if (!spec.identity.name) errors.push('Identity.name is required  (e.g.  - name: My App)');
  if (spec.screens.length === 0) errors.push('At least one screen is required in ## Screens');
  if (
    spec.identity.mode &&
    !MANIFEST_MODES.includes(spec.identity.mode as (typeof MANIFEST_MODES)[number])
  )
    errors.push(`Unknown mode "${spec.identity.mode}" — must be window or kiosk`);
  if (spec.identity.state && !['device', 'file'].includes(spec.identity.state))
    errors.push(`Unknown state "${spec.identity.state}" — must be device or file`);
  if (spec.dataModel.length === 0)
    warnings.push('No data model — add a ## Data Model table if your app stores data');
  if (!spec.identity.schemaVersion) warnings.push('schemaVersion not set — will default to 1');
  if (!spec.identity.state) warnings.push('state not set — will default to device');
  if (!spec.theme.color) warnings.push('Theme color not set — using default');
  if (spec.permissions.length === 0)
    warnings.push('No permissions listed — clipboard, notifications etc. will be unavailable');
  for (const permission of spec.permissions) {
    if (!MANIFEST_PERMISSIONS.includes(permission as (typeof MANIFEST_PERMISSIONS)[number])) {
      errors.push(
        `Unknown permission "${permission}" — must be one of: ${MANIFEST_PERMISSIONS.join(', ')}`,
      );
    }
  }
  return { errors, warnings };
}

function chooseTemplate(spec: AppSpec): ViteTemplateName {
  const fw = (spec.identity.framework ?? '').toLowerCase();
  const map: Record<string, ViteTemplateName> = {
    'vanilla-ts': 'vanilla-ts',
    vanilla: 'vanilla-ts',
    'react-ts': 'react-ts',
    react: 'react-ts',
    'vue-ts': 'vue-ts',
    vue: 'vue-ts',
    form: 'form',
    report: 'report',
  };
  if (map[fw]) return map[fw];
  if ((spec.identity.state ?? 'device') === 'file') {
    return /form|input|fill|edit|write|submit/.test(spec.screens.join(' ').toLowerCase())
      ? 'form'
      : 'report';
  }
  return 'react-ts';
}

function specToUixConfig(spec: AppSpec, slug: string): string {
  const perms =
    spec.permissions.length > 0 ? spec.permissions : ['clipboard-write', 'notifications'];
  return [
    `import { defineConfig } from "@dotuix/types";`,
    '',
    'export default defineConfig({',
    `  id: "${spec.identity.id ?? `com.example.${slug}`}",`,
    `  name: "${spec.identity.name ?? slug}",`,
    `  version: "1.0.0",`,
    `  entry: "index.html",`,
    `  mode: "${spec.identity.mode ?? 'window'}",`,
    `  schemaVersion: ${spec.identity.schemaVersion ?? 1},`,
    `  state: { mode: "${spec.identity.state ?? 'device'}" },`,
    `  permissions: [${perms.map((p) => `"${p}"`).join(', ')}],`,
    `  network: "blocked",`,
    `  theme: { color: "${spec.theme.color ?? '#c8a96e'}", background: "${
      spec.theme.background ?? '#1a1a1a'
    }" },`,
    '});',
  ].join('\n');
}

const SPEC_TEMPLATE = `# App Spec: My App

> Generated by \`dotuix spec init\`. Fill in the sections below, then
> ask your AI assistant to implement the project.
>
> Commands:
>   dotuix spec validate app.spec.md   # check before handing to AI
>   dotuix spec scaffold app.spec.md   # preview generated config + template

## Identity

- id: com.example.my-app
- name: My App
- mode: window          # window | kiosk
- state: device         # device (persists per-viewer) | file (embedded in archive)
- schemaVersion: 1
- framework: react-ts   # vanilla-ts | react-ts | vue-ts | form | report

## Data Model

| Type    | Key fields                                  |
| ------- | ------------------------------------------- |
| item    | name, status, createdAt                     |

## Screens

1. **List** — show all items with status filter and search
2. **Detail** — item detail with edit and delete
3. **New item** — form to create a new item

## Seed Data

- 5 sample items with varied statuses

## Permissions

- clipboard-write
- notifications

## Theme

- color: #c8a96e
- background: #1a1a1a
`;

function cmdSpecInit(args: string[]) {
  const outPath = resolve(pos(args)[0] ?? 'app.spec.md');
  if (existsSync(outPath)) {
    console.error(`${c.red('✗')} Already exists: ${outPath}`);
    process.exit(1);
  }
  writeFileSync(outPath, SPEC_TEMPLATE, 'utf8');
  const rel = outPath.startsWith(process.cwd()) ? outPath.slice(process.cwd().length + 1) : outPath;
  console.log(`\n  ${c.green('✓')} Created ${c.bold(rel)}\n`);
  console.log('  Edit it, then:\n');
  console.log(`    ${c.cyan('dotuix spec validate')} ${rel}`);
  console.log(`    ${c.cyan('dotuix spec scaffold')} ${rel}\n`);
}

function printSpecSummary(spec: AppSpec): void {
  console.log(`  ${c.bold('App:')}         ${spec.identity.name ?? '(unnamed)'}`);
  console.log(`  ${c.bold('ID:')}          ${spec.identity.id ?? '(not set)'}`);
  console.log(
    `  ${c.bold('Mode:')}        ${spec.identity.mode ?? 'window'}` +
      `  /  state: ${spec.identity.state ?? 'device'}`,
  );
  console.log(`  ${c.bold('Template:')}    ${chooseTemplate(spec)}`);
  console.log(`  ${c.bold('Screens:')}     ${spec.screens.length}`);
  if (spec.dataModel.length > 0)
    console.log(`  ${c.bold('Data types:')} ${spec.dataModel.map((d) => d.type).join(', ')}`);
  console.log();
}

function cmdSpecValidate(args: string[]) {
  const specPath = resolve(pos(args)[0] ?? 'app.spec.md');
  if (!existsSync(specPath)) {
    console.error(`${c.red('✗')} File not found: ${specPath}`);
    process.exit(1);
  }
  const spec = parseSpec(readFileSync(specPath, 'utf8'));
  const { errors, warnings } = validateSpec(spec);
  if (errors.length > 0) {
    console.log(`\n  ${c.red('✗')} ${errors.length} error${errors.length > 1 ? 's' : ''}:\n`);
    for (const e of errors) console.log(`    ${c.red('•')} ${e}`);
  }
  if (warnings.length > 0) {
    console.log(
      `\n  ${c.yellow('⚠')} ${warnings.length} warning${warnings.length > 1 ? 's' : ''}:\n`,
    );
    for (const w of warnings) console.log(`    ${c.yellow('•')} ${w}`);
  }
  if (errors.length === 0) {
    console.log(
      `\n  ${c.green('✓')} Spec is valid${
        warnings.length > 0 ? ` (${warnings.length} warning${warnings.length > 1 ? 's' : ''})` : ''
      } — ready to hand to AI\n`,
    );
    printSpecSummary(spec);
  } else {
    process.exit(1);
  }
}

function cmdSpecScaffold(args: string[]) {
  const specPath = resolve(pos(args)[0] ?? 'app.spec.md');
  if (!existsSync(specPath)) {
    console.error(`${c.red('✗')} File not found: ${specPath}`);
    process.exit(1);
  }
  const spec = parseSpec(readFileSync(specPath, 'utf8'));
  const { errors } = validateSpec(spec);
  if (errors.length > 0) {
    console.error(`${c.red('✗')} Spec has errors. Run ${c.cyan('dotuix spec validate')} first.`);
    process.exit(1);
  }

  const displayName = spec.identity.name ?? 'my-app';
  const slug = displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const template = chooseTemplate(spec);
  const outDir = opt(args, '-o', '--output') ?? slug;
  const configContent = specToUixConfig(spec, slug);

  const srcEntry =
    template === 'react-ts' || template === 'report' ? 'src/main.tsx' : 'src/main.ts';
  const srcComponent =
    template === 'react-ts'
      ? 'src/App.tsx'
      : template === 'report'
        ? 'src/Report.tsx'
        : template === 'vue-ts'
          ? 'src/App.vue'
          : null;

  const templateFiles = [
    'package.json',
    'vite.config.ts',
    'tsconfig.json',
    'index.html',
    srcEntry,
    ...(srcComponent ? [srcComponent] : []),
    'src/style.css',
    'README.md',
  ];

  console.log(`\n  ${c.bold('Spec scaffold:')} ${basename(specPath)}\n`);
  console.log(`  ${c.bold('Template:')}   ${c.cyan(template)}`);
  console.log(`  ${c.bold('Output dir:')} ${outDir}/\n`);

  console.log(`  ${c.bold('Files that would be created:')}\n`);
  for (const f of ['uix.config.ts', ...templateFiles])
    console.log(`    ${c.muted('+')} ${outDir}/${f}`);

  console.log(`\n  ${c.bold('Generated uix.config.ts:')}\n`);
  for (const line of configContent.split('\n')) console.log(`    ${c.muted(line)}`);

  if (spec.dataModel.length > 0) {
    console.log(
      `\n  ${c.bold(
        `Data model (${spec.dataModel.length} type${spec.dataModel.length > 1 ? 's' : ''}):`,
      )}\n`,
    );
    for (const d of spec.dataModel)
      console.log(`    ${c.cyan(d.type.padEnd(14))} ${c.muted(d.fields.join(', '))}`);
  }

  if (spec.screens.length > 0) {
    console.log(`\n  ${c.bold(`Screens (${spec.screens.length}):`)}\n`);
    spec.screens.forEach((s, i) => console.log(`    ${c.muted(`${i + 1}.`)} ${s}`));
  }

  if (spec.seedData.length > 0) {
    console.log(`\n  ${c.bold('Seed data:')}\n`);
    for (const s of spec.seedData) console.log(`    ${c.muted('•')} ${s}`);
  }

  console.log(`\n  ${c.bold('Next steps:')}\n`);
  console.log(`    1. ${c.cyan(`dotuix create ${slug} -t ${template}`)}`);
  console.log(`    2. Ask your AI to implement the screens from ${basename(specPath)}`);
  console.log(`    3. ${c.cyan('pnpm install && pnpm dev')}`);
  console.log(`    4. ${c.cyan('pnpm build')} ${c.muted(`# → ${slug}.uix`)}\n`);
}

async function cmdSpec(args: string[]) {
  const sub = args[0];
  if (!sub) {
    console.error(`${c.red('✗')} Usage: dotuix spec <validate|scaffold|init> [args]`);
    process.exit(1);
  }
  const subArgs = args.slice(1);
  if (sub === 'validate') {
    cmdSpecValidate(subArgs);
    return;
  }
  if (sub === 'scaffold') {
    cmdSpecScaffold(subArgs);
    return;
  }
  if (sub === 'init') {
    cmdSpecInit(subArgs);
    return;
  }
  console.error(`${c.red('✗')} Unknown spec subcommand "${sub}". Use: validate, scaffold, init`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// build / dev — thin Vite wrappers
// ---------------------------------------------------------------------------

function resolveViteBin(projectDir: string): string | null {
  const isWin = process.platform === 'win32';
  const bin = join(projectDir, 'node_modules', '.bin', isWin ? 'vite.cmd' : 'vite');
  return existsSync(bin) ? bin : null;
}

function cmdBuild(args: string[]): void {
  const projectDir = pos(args)[0] ? resolve(pos(args)[0]) : process.cwd();
  if (!existsSync(projectDir)) {
    console.error(`${c.red('✗')} Directory not found: ${projectDir}`);
    process.exit(1);
  }
  const viteBin = resolveViteBin(projectDir);
  if (!viteBin) {
    console.error(
      `${c.red('✗')} vite not found in node_modules/.bin/\n${c.muted('  Run: pnpm add -D vite @dotuix/vite-plugin')}`,
    );
    process.exit(1);
  }
  console.log(c.muted(`Building ${projectDir}…\n`));
  const result = spawnSync(viteBin, ['build'], {
    cwd: projectDir,
    stdio: 'inherit',
  });
  process.exit(result.status ?? 0);
}

function cmdDev(args: string[]): void {
  const projectDir = pos(args)[0] ? resolve(pos(args)[0]) : process.cwd();
  if (!existsSync(projectDir)) {
    console.error(`${c.red('✗')} Directory not found: ${projectDir}`);
    process.exit(1);
  }
  const viteBin = resolveViteBin(projectDir);
  if (!viteBin) {
    console.error(
      `${c.red('✗')} vite not found in node_modules/.bin/\n${c.muted('  Run: pnpm add -D vite @dotuix/vite-plugin')}`,
    );
    process.exit(1);
  }
  const proc = spawn(viteBin, ['dev'], { cwd: projectDir, stdio: 'inherit' });
  proc.on('exit', (code) => {
    process.exit(code ?? 0);
  });
}

// ---------------------------------------------------------------------------
// help
// ---------------------------------------------------------------------------
function printHelp() {
  console.log(`
  ${c.bold('dotuix')} — pack, validate and manage .uix files

  ${c.bold('Usage:')}  dotuix ${c.cyan('<command>')} [options]

  ${c.bold('Commands:')}
    ${c.cyan('pack')}     <dir> [-o out.uix]                  Pack a folder → .uix
    ${c.cyan('unpack')}   <file.uix> [-o outDir]              Unpack a .uix file
    ${c.cyan('validate')} <file.uix>                          Validate + offline checks
    ${c.cyan('info')}     <file.uix>                          Show manifest details
    ${c.cyan('init')}     [name] [-t restaurant|catalog|portfolio]  Scaffold a new project
    ${c.cyan('export')}   <file.uix> --type <t>               Export state records (JSON/CSV)
               [--format json|csv] [-o file]
    ${c.cyan('export')}   <file.uix> [--types t1,t2] -o bundle.uixdata  Export .uixdata bundle
    ${c.cyan('import')}   <file.uix> --data bundle.uixdata [--merge]    Import .uixdata bundle
    ${c.cyan('inspect-data')} <bundle.uixdata>                         Inspect a .uixdata bundle
    ${c.cyan('keygen')}   [-o <base>]                         Generate Ed25519 key pair
    ${c.cyan('sign')}     <file.uix> --key <k.priv> [-o out]  Sign a .uix file
    ${c.cyan('verify')}   <file.uix>                          Verify signature
    ${c.cyan('encrypt')}  <file.uix> --pin <PIN> [-o out]     AES-256-GCM encrypt files
    ${c.cyan('seed')}    <records.json> [-o data.db]         Create data.db from JSON records
    ${c.cyan('issue-license')} --app-id <id>|--from <f.uix>     Issue a signed .uixlicense token
               --issued-to <name> --key <k.priv>
               [--expires YYYY-MM-DD] [--device-id <uuid>]
               [--features f1,f2] [--max-devices N] [-o out.uixlicense]
    ${c.cyan('device-id')}                                   Print this device's viewer ID
    ${c.cyan('build')}    [project-dir]                        Run vite build → .uix
    ${c.cyan('dev')}      [project-dir]                        Start dev server with bridge mock
    ${c.cyan(
      'create',
    )}   <name> [-t vanilla-ts|react-ts|vue-ts|form|report]  Scaffold a Vite project
    ${c.cyan('spec init')}  [file]                               Create a starter app.spec.md
    ${c.cyan('spec validate')} <spec.md>                            Validate a spec file
    ${c.cyan(
      'spec scaffold',
    )} <spec.md> [-o dir]                   Preview template + config from spec

  ${c.bold('Examples:')}
    dotuix pack ./my-app
    dotuix validate myapp.uix
    dotuix info myapp.uix
    dotuix init my-restaurant
    dotuix init my-menu -t restaurant
    dotuix export myapp.uix --type order --format csv -o orders.csv
    dotuix keygen -o ministry-key
    dotuix sign briefing.uix --key ministry-key.priv
    dotuix verify briefing.uix
    dotuix encrypt briefing.uix --pin 1234 -o briefing-locked.uix
    dotuix issue-license --from myapp.uix --issued-to "Sunrise Café" --key dotuix-key.priv
    dotuix issue-license --app-id com.example.pos --issued-to "Acme Ltd" --key k.priv --expires 2027-05-21
    dotuix device-id
    dotuix create my-pos -t react-ts
    dotuix create my-invoice -t form
    dotuix spec init
    dotuix spec validate app.spec.md
    dotuix spec scaffold app.spec.md
`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
async function main() {
  const [, , cmd, ...rest] = process.argv;
  if (!cmd || flag([cmd], '-h', '--help', 'help')) {
    printHelp();
    return;
  }
  switch (cmd) {
    case 'pack':
      await cmdPack(rest);
      break;
    case 'unpack':
      await cmdUnpack(rest);
      break;
    case 'validate':
      await cmdValidate(rest);
      break;
    case 'info':
      await cmdInfo(rest);
      break;
    case 'init':
      await cmdInit(rest);
      break;
    case 'export':
      await cmdExport(rest);
      break;
    case 'keygen':
      cmdKeygen(rest);
      break;
    case 'sign':
      await cmdSign(rest);
      break;
    case 'verify':
      await cmdVerify(rest);
      break;
    case 'encrypt':
      await cmdEncrypt(rest);
      break;
    case 'seed':
      await cmdSeed(rest);
      break;
    case 'import':
      await cmdImport(rest);
      break;
    case 'inspect-data':
      await cmdInspectData(rest);
      break;
    case 'issue-license':
      await cmdIssueLicense(rest);
      break;
    case 'device-id':
      cmdDeviceId(rest);
      break;
    case 'build':
      cmdBuild(rest);
      break;
    case 'dev':
      cmdDev(rest);
      break;
    case 'create':
      await cmdCreate(rest);
      break;
    case 'spec':
      await cmdSpec(rest);
      break;
    default:
      console.error(`${c.red('✗')} Unknown command: ${cmd}\n  Run dotuix --help`);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(`${c.red('✗')} ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
