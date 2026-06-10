import { describe, expect, it } from 'vitest';
import { normalizeArchivePath, resolveSafeChild } from '../src/paths.js';

describe('normalizeArchivePath', () => {
  it('normalizes safe nested paths', () => {
    expect(normalizeArchivePath('assets/./img/logo.png')).toBe('assets/img/logo.png');
  });

  it.each([
    '',
    '../escape.txt',
    'nested/../../escape.txt',
    '/tmp/escape.txt',
    '//server/share/file.txt',
    'C:/escape.txt',
    'C:escape.txt',
    '..\\escape.txt',
  ])('rejects unsafe path %s', (unsafe) => {
    expect(() => normalizeArchivePath(unsafe)).toThrow(/Unsafe archive path/);
  });
});

describe('resolveSafeChild', () => {
  it('returns a child path within root', () => {
    const out = resolveSafeChild('/tmp/root', 'nested/file.txt');
    expect(out.endsWith('/tmp/root/nested/file.txt')).toBe(true);
  });

  it('rejects root path writes', () => {
    expect(() => resolveSafeChild('/tmp/root', '.')).toThrow(/Unsafe archive path/);
  });
});
