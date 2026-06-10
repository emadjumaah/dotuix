import { defineConfig } from '@dotuix/types';

export default defineConfig({
  id: 'com.example.__SLUG__',
  name: '__NAME__',
  version: '1.0.0',
  entry: 'index.html',
  mode: 'window',
  schemaVersion: 1,
  state: { mode: 'device' },
  permissions: ['clipboard-write', 'notifications'],
  network: 'blocked',
  theme: { color: '#c8a96e', background: '#1a1a1a' },
});
