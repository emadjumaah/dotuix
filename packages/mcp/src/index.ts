import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createDataDb, resolveSafeChild } from '@dotuix/core';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const execFileAsync = promisify(execFile);

// Read this package's version at runtime so the MCP server reports its true
// version instead of a hardcoded constant that silently drifts from package.json.
const PKG_VERSION = (() => {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as {
      version?: string;
    };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

const SPEC_URL = 'https://dotuix.uts.qa/llms.txt';

// Resolve the dotuix CLI binary — works when @dotuix/cli is a dep or globally installed
let DOTUIX_BIN = 'dotuix';
try {
  DOTUIX_BIN = fileURLToPath(import.meta.resolve('@dotuix/cli/dist/index.js'));
} catch {
  /* fall back to PATH */
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function runDotuix(args: string[]): Promise<{ stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(DOTUIX_BIN, args, {
      timeout: 30_000,
    });
    return { stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    throw new Error(e.stderr?.trim() || e.message || String(err));
  }
}

function formatJsonResult(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: 'dotuix',
  version: PKG_VERSION,
});

// ---------------------------------------------------------------------------
// Tool: get_spec
// ---------------------------------------------------------------------------
server.tool(
  'get_spec',
  'Returns the full .uix format specification — ZIP structure, manifest.json fields, ' +
    'window.__uix bridge API, SQLite schema, compression rules, CLI commands, and code examples. ' +
    'Read this before generating any .uix files.',
  {},
  async () => {
    // Prefer the spec bundled with this package — fully offline, always matches
    // the installed version, and never drifts from a remote copy.
    try {
      const here = dirname(fileURLToPath(import.meta.url));
      const bundled = await readFile(join(here, 'llms.txt'), 'utf8');
      if (bundled.trim()) return { content: [{ type: 'text', text: bundled }] };
    } catch {
      /* bundled spec missing — fall through to network */
    }
    try {
      const res = await fetch(SPEC_URL);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      return { content: [{ type: 'text', text }] };
    } catch {
      // Fallback: return bundled summary if network is unavailable
      return {
        content: [
          {
            type: 'text',
            text: [
              '# .uix format — quick reference',
              '',
              'A .uix file is a ZIP archive with a manifest.json at the root and an HTML entry point.',
              '',
              '## Minimal manifest.json',
              '```json',
              JSON.stringify(
                {
                  uix: '1.0',
                  id: 'com.example.myapp',
                  name: 'My App',
                  version: '1.0.0',
                  entry: 'index.html',
                  mode: 'kiosk',
                  network: 'blocked',
                },
                null,
                2,
              ),
              '```',
              '',
              '## window.__uix bridge API',
              '```javascript',
              'const manifest = await uix.manifest();',
              "const records  = await uix.data.find({ type: 'product' });",
              "const one      = await uix.data.get('product:001');",
              "const inserted = await uix.state.insert({ type: 'cart_item', body: { qty: 1 } });",
              'await uix.state.update(inserted.id, { qty: 2 });',
              'await uix.state.delete(inserted.id);',
              '```',
              '',
              `Full spec: ${SPEC_URL}`,
            ].join('\n'),
          },
        ],
      };
    }
  },
);

// ---------------------------------------------------------------------------
// Tool: validate
// ---------------------------------------------------------------------------
server.tool(
  'validate',
  'Validate an existing .uix file. Returns a structured result with valid/invalid status, ' +
    'any errors, and any warnings. Pass an absolute path to the .uix file.',
  { path: z.string().describe('Absolute path to the .uix file to validate.') },
  async ({ path }) => {
    const abs = resolve(path);
    // `validate --json` emits a structured result on stdout and exits non-zero
    // when the file is invalid — capture stdout regardless of exit code.
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync(DOTUIX_BIN, ['validate', abs, '--json'], {
        timeout: 30_000,
      }));
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      if (e.stdout?.trim().startsWith('{')) {
        stdout = e.stdout;
      } else {
        throw new Error(e.stderr?.trim() || e.message || String(err));
      }
    }
    const parsed = JSON.parse(stdout) as {
      valid: boolean;
      errors: string[];
      warnings: string[];
    };
    return {
      content: [{ type: 'text', text: formatJsonResult(parsed) }],
    };
  },
);

// ---------------------------------------------------------------------------
// Tool: info
// ---------------------------------------------------------------------------
server.tool(
  'info',
  'Read the manifest.json from a .uix file without fully unpacking it. ' +
    'Returns the manifest as a JSON object. Pass an absolute path to the .uix file.',
  { path: z.string().describe('Absolute path to the .uix file.') },
  async ({ path }) => {
    const abs = resolve(path);
    const { stdout } = await runDotuix(['info', abs, '--json']);
    return {
      content: [{ type: 'text', text: stdout }],
    };
  },
);

// ---------------------------------------------------------------------------
// Tool: pack
// ---------------------------------------------------------------------------
server.tool(
  'pack',
  'Pack a directory into a .uix file using the dotuix CLI. ' +
    'The directory must contain a valid manifest.json at its root. ' +
    'Returns the path to the output .uix file.',
  {
    directory: z.string().describe('Absolute path to the directory to pack.'),
    output: z
      .string()
      .optional()
      .describe(
        'Absolute path for the output .uix file. Defaults to <directory-name>.uix next to the directory.',
      ),
  },
  async ({ directory, output }) => {
    const dir = resolve(directory);
    const args = ['pack', dir];
    if (output) {
      args.push('-o', resolve(output));
    }
    const { stdout } = await runDotuix(args);
    // Extract output path from CLI stdout
    const match = stdout.match(/→\s*(.+\.uix)/);
    const outPath = match ? match[1].trim() : stdout;
    return {
      content: [
        {
          type: 'text',
          text: formatJsonResult({
            success: true,
            path: outPath,
            output: stdout,
          }),
        },
      ],
    };
  },
);

// ---------------------------------------------------------------------------
// Tool: init
// ---------------------------------------------------------------------------
server.tool(
  'init',
  'Scaffold a new .uix project using the dotuix CLI. Creates a directory with manifest.json, ' +
    'index.html, app.js, style.css, and optionally a data.db seed. ' +
    'Returns the list of created files.',
  {
    name: z.string().describe("Project name and directory name. e.g. 'my-app'"),
    template: z
      .enum(['blank', 'restaurant', 'catalog', 'portfolio'])
      .optional()
      .describe("Starter template. 'blank' (default), 'restaurant', 'catalog', or 'portfolio'."),
    directory: z
      .string()
      .optional()
      .describe(
        'Parent directory where the project folder will be created. Defaults to a temp directory.',
      ),
  },
  async ({ name, template, directory }) => {
    const parent = directory ? resolve(directory) : join(tmpdir(), `dotuix-${randomUUID()}`);
    await mkdir(parent, { recursive: true });

    const args = ['init', name];
    if (template && template !== 'blank') {
      args.push('-t', template);
    }

    const { stdout } = await execFileAsync(DOTUIX_BIN, args, {
      cwd: parent,
      timeout: 30_000,
    });
    const projectDir = join(parent, name);

    return {
      content: [
        {
          type: 'text',
          text: formatJsonResult({
            success: true,
            projectDir,
            output: stdout.trim(),
            nextStep: `Edit the files in ${projectDir}, then call pack({ directory: "${projectDir}" })`,
          }),
        },
      ],
    };
  },
);

// ---------------------------------------------------------------------------
// Tool: write_files
// ---------------------------------------------------------------------------
server.tool(
  'write_files',
  'Write a set of files into an existing project directory. Use this after init to customise the ' +
    'generated files with your own HTML/JS/CSS content before packing. ' +
    'Pass an array of { path, content } pairs where path is relative to the project directory.',
  {
    directory: z.string().describe('Absolute path to the project directory.'),
    files: z
      .array(
        z.object({
          path: z.string().describe("Relative path from the project directory, e.g. 'index.html'"),
          content: z.string().describe('File content as a UTF-8 string.'),
        }),
      )
      .describe('Files to write.'),
  },
  async ({ directory, files }) => {
    const dir = resolve(directory);
    const written: string[] = [];

    for (const file of files) {
      const fullPath = resolveSafeChild(dir, file.path);
      const parent = dirname(fullPath);
      await mkdir(parent, { recursive: true });
      await writeFile(fullPath, file.content, 'utf8');
      written.push(file.path);
    }

    // Auto-stamp ai provenance in manifest.json if the caller included one
    // and it doesn't already have an ai block.
    const manifestFile = files.find((f) => f.path === 'manifest.json');
    if (manifestFile) {
      const manifestPath = join(dir, 'manifest.json');
      try {
        const raw = JSON.parse(await readFile(manifestPath, 'utf8'));
        if (!raw.ai) {
          raw.ai = {
            generatedBy: '@dotuix/mcp',
            generatedAt: new Date().toISOString(),
          };
          await writeFile(manifestPath, JSON.stringify(raw, null, 2), 'utf8');
        }
      } catch {
        // Not valid JSON — leave as-is, validation will catch it later
      }
    }

    return {
      content: [
        {
          type: 'text',
          text: formatJsonResult({ success: true, written }),
        },
      ],
    };
  },
);

// ---------------------------------------------------------------------------
// Tool: create  (init + write_files + pack in one shot)
// ---------------------------------------------------------------------------
server.tool(
  'create',
  'Create a complete .uix file in one atomic step — ideal for AI-generated apps. ' +
    'Provide the manifest as a JSON object, all source files as { path, content } pairs, ' +
    'and optionally creator records to seed into data.db. ' +
    'The tool initialises the project directory, writes your files, seeds data.db if records are supplied, ' +
    'auto-stamps the ai provenance block, and packs everything into a ready-to-use .uix file. ' +
    'Returns the absolute output path. Use this instead of chaining init → write_files → pack.',
  {
    name: z.string().describe('App name, used as the directory and output filename.'),
    manifest: z
      .record(z.unknown())
      .describe(
        'manifest.json content as a JSON object (without the ai block — it is stamped automatically).',
      ),
    files: z
      .array(
        z.object({
          path: z.string().describe("Relative path from project root, e.g. 'index.html'"),
          content: z.string().describe('UTF-8 file content.'),
        }),
      )
      .describe(
        'Source files (index.html, app.js, style.css, …). Do NOT include manifest.json here.',
      ),
    dataRecords: z
      .array(
        z.object({
          id: z
            .string()
            .optional()
            .describe(
              "Optional explicit id, e.g. 'product:001'. Auto-generated as '<type>:<uuid>' when omitted.",
            ),
          type: z.string().describe("Record type, e.g. 'product', 'category', 'article'."),
          body: z
            .record(z.unknown())
            .describe('Record body as a plain object — the schema is entirely app-defined.'),
        }),
      )
      .optional()
      .describe(
        'Creator records to seed into data.db (read-only content: menu items, products, catalog). ' +
          'Use this instead of hardcoding content arrays in app.js. ' +
          "App reads them at runtime with uix.data.find({ type: 'product' }).",
      ),
    directory: z
      .string()
      .optional()
      .describe('Parent directory for the project folder. Defaults to a temp directory.'),
    generatedBy: z
      .string()
      .optional()
      .describe(
        "Override the ai.generatedBy stamp, e.g. 'claude-opus-4'. Defaults to '@dotuix/mcp'.",
      ),
  },
  async ({ name, manifest, files, dataRecords, directory, generatedBy }) => {
    const parent = directory ? resolve(directory) : join(tmpdir(), `dotuix-${randomUUID()}`);
    await mkdir(parent, { recursive: true });
    const projectDir = resolveSafeChild(parent, name);
    await mkdir(projectDir, { recursive: true });

    // Stamp ai provenance
    const stamped = {
      ...manifest,
      ai: {
        ...(typeof manifest.ai === 'object' && manifest.ai !== null ? (manifest.ai as object) : {}),
        generatedBy: generatedBy ?? '@dotuix/mcp',
        generatedAt: new Date().toISOString(),
      },
    };

    // Write manifest
    await writeFile(join(projectDir, 'manifest.json'), JSON.stringify(stamped, null, 2), 'utf8');

    // Write source files
    for (const file of files) {
      const fullPath = resolveSafeChild(projectDir, file.path);
      const fileParent = dirname(fullPath);
      await mkdir(fileParent, { recursive: true });
      await writeFile(fullPath, file.content, 'utf8');
    }

    // Seed data.db if creator records were provided
    if (dataRecords && dataRecords.length > 0) {
      const bytes = await createDataDb(
        dataRecords as Array<{
          id?: string;
          type: string;
          body: Record<string, unknown>;
        }>,
      );
      await writeFile(join(projectDir, 'data.db'), bytes);
    }

    // Pack
    const outputPath = resolveSafeChild(parent, `${name}.uix`);
    const { stdout } = await runDotuix(['pack', projectDir, '-o', outputPath]);

    const filesWritten = ['manifest.json', ...files.map((f) => f.path)];
    if (dataRecords && dataRecords.length > 0) filesWritten.push('data.db');

    return {
      content: [
        {
          type: 'text',
          text: formatJsonResult({
            success: true,
            path: outputPath,
            filesWritten,
            dataRecordsSeeded: dataRecords?.length ?? 0,
            output: stdout.trim(),
          }),
        },
      ],
    };
  },
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
const transport = new StdioServerTransport();
await server.connect(transport);
