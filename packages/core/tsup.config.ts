import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'es2022',
  // Node built-ins + sql.js (WASM binary must stay in its own node_modules dir)
  external: ['node:fs', 'node:path', 'node:os', 'node:crypto', 'sql.js'],
});
