import { isAbsolute, posix, relative, resolve } from 'node:path';

const WINDOWS_DRIVE_RE = /^[a-zA-Z]:/;

export function normalizeArchivePath(path: string): string {
  const candidate = path.replace(/\\/g, '/');

  if (!candidate || candidate.includes('\0')) {
    throw new Error('Unsafe archive path: path must be non-empty');
  }

  if (candidate.startsWith('/') || candidate.startsWith('//') || WINDOWS_DRIVE_RE.test(path)) {
    throw new Error(`Unsafe archive path: ${path}`);
  }

  const normalized = posix.normalize(candidate);
  if (
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    posix.isAbsolute(normalized)
  ) {
    throw new Error(`Unsafe archive path: ${path}`);
  }

  return normalized;
}

export function resolveSafeChild(root: string, childPath: string): string {
  const safeChild = normalizeArchivePath(childPath);
  const safeRoot = resolve(root);
  const target = resolve(safeRoot, safeChild);
  const rel = relative(safeRoot, target);

  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Path escapes target directory: ${childPath}`);
  }

  return target;
}
