import { defineConfig } from '@dotuix/types';

export default defineConfig({
  id: 'com.dotuix.demos.posadvanced',
  name: 'Nexus POS',
  version: '2.0.0',
  entry: 'index.html',
  mode: 'kiosk',
  schemaVersion: 2,
  state: { mode: 'device', seed: true },
  permissions: [
    'print',
    'file-save',
    'file-open',
    'notifications',
    'fullscreen',
    'raw-sql',
    'clipboard-write',
  ],
  network: 'blocked',
  theme: { color: '#c8a96e', background: '#1a1a1a' },
});
