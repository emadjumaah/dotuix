import { defineConfig } from '@dotuix/types';

export default defineConfig({
  id: 'com.example.__SLUG__',
  name: '__NAME__',
  version: '1.0.0',
  entry: 'index.html',
  mode: 'window',
  schemaVersion: 1,
  // state.mode "file" → report data is embedded in the archive.
  // Generate the report, pack it, share the .uix — the data travels with it.
  state: { mode: 'file' },
  permissions: ['print'],
  network: 'blocked',
  theme: { color: '#2563eb', background: '#ffffff' },
});
