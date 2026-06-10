import { defineConfig } from '@dotuix/types';

export default defineConfig({
  id: 'com.example.__SLUG__',
  name: '__NAME__',
  version: '1.0.0',
  entry: 'index.html',
  mode: 'window',
  schemaVersion: 1,
  // state.mode "file" → data is stored inside the .uix archive.
  // Sharing the file shares all filled-in data (like a Word document).
  state: { mode: 'file' },
  permissions: ['clipboard-write', 'print'],
  network: 'blocked',
  theme: { color: '#4f8ef7', background: '#f8f9fb' },
});
