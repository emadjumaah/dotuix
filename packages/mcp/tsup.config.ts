import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  outDir: 'dist',
  clean: true,
  banner: { js: '#!/usr/bin/env node' },
  // Exclude MCP SDK from bundle so it's resolved from node_modules at runtime
  external: ['@modelcontextprotocol/sdk'],
});
