import { describe, expect, it } from 'vitest';
import { parseManifest, safeParseManifest } from '../src/manifest.js';

const BASE = {
  uix: '1.0',
  id: 'com.test.app',
  name: 'Test App',
  version: '1.0.0',
  entry: 'index.html',
  mode: 'window',
} as const;

describe('parseManifest', () => {
  it('accepts a valid minimal manifest', () => {
    const m = parseManifest(BASE);
    expect(m.id).toBe('com.test.app');
    expect(m.network).toBe('blocked'); // default
    expect(m.permissions).toEqual([]); // default
  });

  it('accepts kiosk mode', () => {
    const m = parseManifest({ ...BASE, mode: 'kiosk' });
    expect(m.mode).toBe('kiosk');
  });

  it('accepts all valid permissions', () => {
    const permissions = [
      'local-storage',
      'print',
      'clipboard-write',
      'fullscreen',
      'raw-sql',
      'local-sync',
    ] as const;
    const m = parseManifest({ ...BASE, permissions });
    expect(m.permissions).toEqual(permissions);
  });

  it('accepts optional fields', () => {
    const m = parseManifest({
      ...BASE,
      author: 'Test Author',
      expires: '2099-12-31',
      theme: { color: '#fff', background: '#000' },
      state: { seed: true },
      signature: null,
      minViewer: '1.0.0',
    });
    expect(m.author).toBe('Test Author');
    expect(m.expires).toBe('2099-12-31');
    expect(m.theme?.color).toBe('#fff');
    expect(m.state?.seed).toBe(true);
    expect(m.signature).toBeNull();
    expect(m.minViewer).toBe('1.0.0');
  });

  it('throws on missing required field: id', () => {
    const { id: _id, ...rest } = BASE;
    expect(() => parseManifest(rest)).toThrow();
  });

  it('throws on invalid id format (not reverse-domain)', () => {
    expect(() => parseManifest({ ...BASE, id: 'myapp' })).toThrow(/reverse-domain/);
    expect(() => parseManifest({ ...BASE, id: 'com.MyApp' })).toThrow(/reverse-domain/);
    expect(() => parseManifest({ ...BASE, id: 'com.' })).toThrow(/reverse-domain/);
  });

  it('throws on invalid mode', () => {
    expect(() => parseManifest({ ...BASE, mode: 'fullscreen' })).toThrow();
  });

  it('throws on unknown permission', () => {
    expect(() => parseManifest({ ...BASE, permissions: ['camera'] })).toThrow();
  });
});

describe('safeParseManifest', () => {
  it('returns success: true for valid input', () => {
    const result = safeParseManifest(BASE);
    expect(result.success).toBe(true);
  });

  it('returns success: false with error details for invalid input', () => {
    const result = safeParseManifest({ ...BASE, id: 'INVALID' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.length).toBeGreaterThan(0);
    }
  });
});
