import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pack, resolveSafeChild } from '@dotuix/core';
import type { UIXAiMeta } from '@dotuix/core';

export type { UIXAiMeta };
export type { Manifest } from '@dotuix/core';

// ---------------------------------------------------------------------------
// createUIX
// ---------------------------------------------------------------------------

export interface CreateUIXOptions {
  /**
   * manifest.json fields. The `ai` block is merged and stamped automatically —
   * you do not need to set `ai.generatedBy` or `ai.generatedAt` yourself.
   */
  manifest: Record<string, unknown>;

  /**
   * Source files as a map of relative-path → UTF-8 content.
   * E.g. `{ "index.html": "<html>…", "app.js": "…" }`
   * Do NOT include manifest.json — that is handled via the `manifest` field.
   */
  files: Record<string, string>;

  /**
   * Absolute path for the output .uix file.
   * Defaults to a uniquely-named file in the OS temp directory.
   */
  output?: string;

  /**
   * Overrides `ai.generatedBy` in the manifest.
   * Defaults to `"@dotuix/ai"`.
   */
  generatedBy?: string;
}

/**
 * Create a `.uix` file from in-memory sources.
 *
 * ```ts
 * import { createUIX } from "@dotuix/ai";
 *
 * const path = await createUIX({
 *   manifest: {
 *     uix: "1.0",
 *     id: "com.example.myapp",
 *     name: "My App",
 *     version: "1.0.0",
 *     entry: "index.html",
 *     mode: "window",
 *   },
 *   files: {
 *     "index.html": "<html><body><h1>Hello</h1></body></html>",
 *     "app.js": "console.log('ready');",
 *   },
 * });
 *
 * console.log(path); // /tmp/dotuix-xxx/myapp.uix
 * ```
 *
 * @returns Absolute path to the packed `.uix` file.
 */
export async function createUIX(options: CreateUIXOptions): Promise<string> {
  const { manifest, files, output, generatedBy = '@dotuix/ai' } = options;

  const workDir = join(tmpdir(), `dotuix-${randomUUID()}`);
  const projectName =
    typeof manifest.name === 'string'
      ? manifest.name.toLowerCase().replace(/[^a-z0-9-]/g, '-')
      : randomUUID();
  const projectDir = resolveSafeChild(workDir, projectName);
  await mkdir(projectDir, { recursive: true });

  // Stamp ai provenance
  const ai: UIXAiMeta = {
    ...(typeof manifest.ai === 'object' && manifest.ai !== null ? (manifest.ai as UIXAiMeta) : {}),
    generatedBy,
    generatedAt: new Date().toISOString(),
  };

  const stamped = { ...manifest, ai };

  // Write manifest
  await writeFile(join(projectDir, 'manifest.json'), JSON.stringify(stamped, null, 2), 'utf8');

  // Write source files
  for (const [relativePath, content] of Object.entries(files)) {
    const fullPath = resolveSafeChild(projectDir, relativePath);
    const parent = dirname(fullPath);
    if (parent !== projectDir) {
      await mkdir(parent, { recursive: true });
    }
    await writeFile(fullPath, content, 'utf8');
  }

  // Pack
  const outputPath = output ?? join(workDir, `${projectName}.uix`);
  await pack(projectDir, outputPath);

  // Clean up source dir but keep the output .uix
  await rm(projectDir, { recursive: true, force: true });

  return outputPath;
}
