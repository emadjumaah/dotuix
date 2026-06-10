import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import DbViewer from './components/DbViewer';
import { emitDesktopEvent } from './observability.js';

function BrandIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="3" y="3" width="8" height="8" rx="2" fill="#fff" opacity="0.95" />
      <rect x="13" y="3" width="8" height="8" rx="2" fill="#fff" opacity="0.95" />
      <rect x="3" y="13" width="8" height="8" rx="2" fill="#fff" opacity="0.95" />
      <rect x="13" y="13" width="8" height="8" rx="2" fill="#fff" opacity="0.45" />
    </svg>
  );
}

function Spinner({ size = 16 }: { size?: number }) {
  return (
    <svg className="spinner" width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" opacity="0.25" />
      <path d="M8 2a6 6 0 0 1 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

type LoadResult =
  | { status: 'loaded'; manifest: string; path: string }
  | { status: 'pin_required'; app_name: string; app_id: string }
  | {
      status: 'license_required';
      app_name: string;
      app_id: string;
      device_id: string;
      uix_path: string;
    };

type Manifest = {
  name?: string;
  entry?: string;
  expires?: string | null;
  network?: 'blocked' | 'allowed';
  permissions?: string[];
  sync?: {
    endpoint?: string;
    secret?: string;
  };
  signature?: { algorithm: string };
};

type ViewerState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'pin_required'; appName: string }
  | {
      status: 'license_required';
      appName: string;
      appId: string;
      deviceId: string;
      uixPath: string;
    }
  | {
      status: 'loaded';
      manifestName: string;
      appPath: string;
      entryPath: string;
      expires?: string;
      signed: boolean;
      networkAllowed: boolean;
      autoSyncEnabled: boolean;
    }
  | { status: 'error'; message: string };

type FrameDiagnostic = {
  ts: number;
  stage: string;
  detail: string;
};

const FRAME_INIT_TIMEOUT_MS = 8000;
const AUTO_SYNC_INTERVAL_MS = 10_000;

function normalizeEntryPath(entry: string | undefined): string {
  const raw = (entry ?? 'index.html').trim();
  if (!raw) return 'index.html';
  return raw.replace(/\\/g, '/').replace(/^\/+/, '');
}

function normalizeFallbackAbsolutePath(path: string): string {
  // asset.localhost URL conversion expects slash-separated paths on Windows.
  return path.replace(/\\/g, '/');
}

function toAssetLocalhostUrl(path: string): string {
  const normalized = normalizeFallbackAbsolutePath(path).replace(/^\/+/, '');
  const encodedPath = normalized
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `http://asset.localhost/${encodedPath}`;
}

function isWindowsHost(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /windows/i.test(`${navigator.userAgent} ${navigator.platform}`);
}

function encodeEntryUrlPath(entryPath: string): string {
  return entryPath
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function handleLoadResult(result: LoadResult): ViewerState {
  if (result.status === 'loaded') {
    const m = JSON.parse(result.manifest) as Manifest;
    const permissions = m.permissions ?? [];
    const autoSyncEnabled =
      permissions.includes('local-sync') &&
      typeof m.sync?.secret === 'string' &&
      m.sync.secret.trim().length > 0;

    return {
      status: 'loaded',
      manifestName: m.name ?? 'UIX App',
      appPath: result.path,
      entryPath: normalizeEntryPath(m.entry),
      expires: m.expires ?? undefined,
      signed: !!m.signature,
      networkAllowed: m.network === 'allowed',
      autoSyncEnabled,
    };
  }
  if (result.status === 'license_required') {
    return {
      status: 'license_required',
      appName: result.app_name,
      appId: result.app_id,
      deviceId: result.device_id,
      uixPath: result.uix_path,
    };
  }
  return { status: 'pin_required', appName: result.app_name };
}

function daysUntil(dateStr: string): number {
  return Math.ceil((new Date(dateStr).getTime() - Date.now()) / 86_400_000);
}

const RECENT_FILES_KEY = 'dotuix.viewer.recent.files';

function readRecentFiles(): string[] {
  try {
    const raw = window.localStorage.getItem(RECENT_FILES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((p): p is string => typeof p === 'string');
  } catch {
    return [];
  }
}

function writeRecentFiles(paths: string[]) {
  try {
    window.localStorage.setItem(RECENT_FILES_KEY, JSON.stringify(paths));
  } catch {
    // Ignore storage errors; viewer still works without recents persistence.
  }
}

function filenameFromPath(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

export default function App() {
  const [state, setState] = useState<ViewerState>({ status: 'idle' });
  const [recentFiles, setRecentFiles] = useState<string[]>(() => readRecentFiles());
  const [pin, setPin] = useState('');
  const [pinError, setPinError] = useState('');
  const [isDragOver, setIsDragOver] = useState(false);
  const [dbOpen, setDbOpen] = useState(false);
  const [dbStatePath, setDbStatePath] = useState<string | null>(null);
  const [dbDataPath, setDbDataPath] = useState<string | null>(null);
  const [frameReloadNonce, setFrameReloadNonce] = useState(0);
  const [frameSrcOverride, setFrameSrcOverride] = useState<string | null>(null);
  const [frameFallbackPreparing, setFrameFallbackPreparing] = useState(false);
  const [frameFatal, setFrameFatal] = useState<string | null>(null);
  const [frameIframeLoaded, setFrameIframeLoaded] = useState(false);
  const [frameBridgeBootstrapped, setFrameBridgeBootstrapped] = useState(false);
  const [frameDomLoaded, setFrameDomLoaded] = useState(false);
  const [frameWindowLoaded, setFrameWindowLoaded] = useState(false);
  const [frameDiagnostics, setFrameDiagnostics] = useState<FrameDiagnostic[]>([]);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const stateRef = useRef(state);
  const autoSyncLastErrorAtRef = useRef(0);
  const loadedEntryPath = state.status === 'loaded' ? state.entryPath : '';
  const loadedAppPath = state.status === 'loaded' ? state.appPath : '';
  const preferTempFallbackFirst = state.status === 'loaded' && isWindowsHost();
  const protocolFrameSrc =
    state.status === 'loaded' ? `uix://localhost/${encodeEntryUrlPath(state.entryPath)}` : '';
  const activeFrameSrc =
    state.status === 'loaded'
      ? (frameSrcOverride ?? (preferTempFallbackFirst ? '' : protocolFrameSrc))
      : '';
  const waitingForFallbackSource =
    state.status === 'loaded' && preferTempFallbackFirst && !frameSrcOverride;
  const loadedFrameKey =
    state.status === 'loaded'
      ? `${loadedAppPath}|${loadedEntryPath}|${frameReloadNonce}|${activeFrameSrc}`
      : '';

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const pushFrameDiagnostic = useCallback((stage: string, detail: string) => {
    setFrameDiagnostics((prev) => [...prev, { ts: Date.now(), stage, detail }].slice(-12));
  }, []);

  const startTempFileFallback = useCallback(
    (trigger: string, detail: string): boolean => {
      if (stateRef.current.status !== 'loaded') return false;
      if (frameFallbackPreparing) return true;
      if (frameSrcOverride !== null) return false;

      setFrameFallbackPreparing(true);
      pushFrameDiagnostic('viewer.fallback_prepare', `${trigger}: ${detail}`);

      void invoke<string>('prepare_iframe_fallback_entry', {
        entryPath: loadedEntryPath,
      })
        .then((entryFilePath) => {
          const normalizedEntryFilePath = normalizeFallbackAbsolutePath(entryFilePath);
          const fallbackSrc = isWindowsHost()
            ? toAssetLocalhostUrl(normalizedEntryFilePath)
            : convertFileSrc(normalizedEntryFilePath);
          setFrameSrcOverride(fallbackSrc);
          setFrameFatal(null);
          pushFrameDiagnostic(
            'viewer.fallback_ready',
            `Loaded temporary entry file: ${entryFilePath}`,
          );
        })
        .catch((error) => {
          const message = `Fallback preparation failed: ${String(error)}`;
          pushFrameDiagnostic('viewer.fallback_failed', message);
          setFrameFatal(
            (prev) =>
              prev ?? 'The app page did not initialize correctly. Open diagnostics and retry.',
          );
          emitDesktopEvent({
            code: 'desktop.viewer.frame_init_timeout',
            severity: 'error',
            reason: 'fallback_prepare_failed',
            metadata: {
              entryPath: loadedEntryPath,
              error: String(error),
            },
          });
        })
        .finally(() => {
          setFrameFallbackPreparing(false);
        });

      return true;
    },
    [frameFallbackPreparing, frameSrcOverride, loadedEntryPath, pushFrameDiagnostic],
  );

  useEffect(() => {
    if (!loadedFrameKey) {
      setFrameSrcOverride(null);
      setFrameFallbackPreparing(false);
      setFrameFatal(null);
      setFrameIframeLoaded(false);
      setFrameBridgeBootstrapped(false);
      setFrameDomLoaded(false);
      setFrameWindowLoaded(false);
      setFrameDiagnostics([]);
      return;
    }

    setFrameFatal(null);
    setFrameFallbackPreparing(false);
    setFrameIframeLoaded(false);
    setFrameBridgeBootstrapped(false);
    setFrameDomLoaded(false);
    setFrameWindowLoaded(false);
    setFrameDiagnostics([]);
    pushFrameDiagnostic('viewer.entry_requested', `entry=${loadedEntryPath} src=${activeFrameSrc}`);
  }, [loadedFrameKey, loadedEntryPath, activeFrameSrc, pushFrameDiagnostic]);

  useEffect(() => {
    if (!waitingForFallbackSource) return;

    startTempFileFallback(
      'windows_primary',
      'Using temporary fallback source as primary mode on Windows.',
    );
  }, [waitingForFallbackSource, startTempFileFallback]);

  useEffect(() => {
    if (!loadedFrameKey || !activeFrameSrc) return;

    const timer = window.setTimeout(() => {
      if (frameIframeLoaded && frameBridgeBootstrapped) return;

      if (frameIframeLoaded && !frameBridgeBootstrapped) {
        const detail = 'Iframe loaded but bridge bootstrap signal is missing; keeping app visible.';
        pushFrameDiagnostic('viewer.init_timeout_soft', detail);
        emitDesktopEvent({
          code: 'desktop.viewer.frame_init_timeout',
          severity: 'warn',
          reason: 'bridge_bootstrap_missing_non_blocking',
          metadata: {
            entryPath: loadedEntryPath,
            source: activeFrameSrc,
          },
        });
        return;
      }

      const missing: string[] = [];
      if (!frameIframeLoaded) missing.push('iframe load event');
      if (!frameBridgeBootstrapped) missing.push('bridge bootstrap');

      const detail = `Missing signals: ${missing.join(', ')}`;
      pushFrameDiagnostic('viewer.init_timeout', detail);

      if (startTempFileFallback('init_timeout', detail)) {
        return;
      }

      setFrameFatal(
        (prev) => prev ?? 'The app page did not initialize correctly. Open diagnostics and retry.',
      );
      emitDesktopEvent({
        code: 'desktop.viewer.frame_init_timeout',
        severity: 'error',
        reason: 'init_timeout',
        metadata: {
          entryPath: loadedEntryPath,
          missing: missing.join(', '),
        },
      });
    }, FRAME_INIT_TIMEOUT_MS);

    return () => window.clearTimeout(timer);
  }, [
    loadedFrameKey,
    activeFrameSrc,
    frameIframeLoaded,
    frameBridgeBootstrapped,
    loadedEntryPath,
    pushFrameDiagnostic,
    startTempFileFallback,
  ]);

  useEffect(() => {
    if (frameFatal && frameIframeLoaded && frameBridgeBootstrapped) {
      setFrameFatal(null);
      pushFrameDiagnostic('viewer.recovered', 'Frame recovered after delayed initialization.');
    }
  }, [frameFatal, frameIframeLoaded, frameBridgeBootstrapped, pushFrameDiagnostic]);

  const registerRecentFile = useCallback((path: string) => {
    const normalized = path.trim();
    if (!normalized) return;
    setRecentFiles((prev) => {
      const next = [normalized, ...prev.filter((p) => p !== normalized)].slice(0, 12);
      writeRecentFiles(next);
      return next;
    });
  }, []);

  const clearRecentFiles = useCallback(() => {
    setRecentFiles([]);
    writeRecentFiles([]);
  }, []);

  const removeRecentFile = useCallback((path: string) => {
    setRecentFiles((prev) => {
      const next = prev.filter((p) => p !== path);
      writeRecentFiles(next);
      return next;
    });
  }, []);

  const applyLoadResult = useCallback(
    (result: LoadResult) => {
      if (result.status === 'loaded') {
        registerRecentFile(result.path);
      }
      setState(handleLoadResult(result));
    },
    [registerRecentFile],
  );

  const loadPath = useCallback(
    async (path: string) => {
      setState({ status: 'loading' });
      try {
        const result = await invoke<LoadResult>('load_uix', { path });
        applyLoadResult(result);
      } catch (err) {
        setState({ status: 'error', message: String(err) });
      }
    },
    [applyLoadResult],
  );

  // ── Bridge: relay postMessages from the uix:// iframe to Tauri ──────────
  // useLayoutEffect fires before browser paint, so the listener is always
  // registered before the iframe's JS can execute and send postMessages.
  // biome-ignore lint/correctness/useExhaustiveDependencies: relay re-subscribes only on load-status change; other captured refs are stable for the session.
  useLayoutEffect(() => {
    if (state.status !== 'loaded') return;

    const expectedIframeOrigin = 'uix://localhost';
    const normalizeOrigin = (origin: string) => origin.replace(/\/+$/, '').toLowerCase();
    const expectedOriginNormalized = normalizeOrigin(expectedIframeOrigin);
    const iframeSrcOrigin = (() => {
      const src = iframeRef.current?.src;
      if (!src) return null;
      try {
        return normalizeOrigin(new URL(src).origin);
      } catch {
        return null;
      }
    })();

    const handler = async (e: MessageEvent) => {
      if (e.source !== iframeRef.current?.contentWindow) return;
      const rawOrigin = (e.origin ?? '').trim();
      const isOpaqueOrigin = rawOrigin === 'null' || rawOrigin === '';
      const normalizedOrigin = normalizeOrigin(rawOrigin);
      const isUixLocalhostOrigin = /^uix:\/\/localhost(?::\d+)?$/i.test(normalizedOrigin);
      const originAllowed =
        isOpaqueOrigin ||
        normalizedOrigin === expectedOriginNormalized ||
        (iframeSrcOrigin !== null && normalizedOrigin === iframeSrcOrigin) ||
        isUixLocalhostOrigin;

      if (!originAllowed) {
        emitDesktopEvent({
          code: 'desktop.bridge.origin_rejected',
          severity: 'warn',
          reason: 'unexpected_origin',
          metadata: {
            origin: rawOrigin,
            expected: expectedIframeOrigin,
            iframeSrcOrigin,
          },
        });
        return;
      }

      if (
        typeof e.data === 'object' &&
        e.data !== null &&
        '__dotuix_status' in e.data &&
        (e.data as { __dotuix_status?: unknown }).__dotuix_status === true
      ) {
        const statusType =
          typeof (e.data as { type?: unknown }).type === 'string'
            ? (e.data as { type: string }).type
            : 'unknown';
        const statusDetail =
          typeof (e.data as { detail?: unknown }).detail === 'string'
            ? (e.data as { detail: string }).detail
            : 'No detail';

        pushFrameDiagnostic(`iframe.${statusType}`, statusDetail);

        if (statusType === 'bridge_bootstrap') {
          setFrameBridgeBootstrapped(true);
        } else if (statusType === 'dom_content_loaded') {
          setFrameDomLoaded(true);
        } else if (statusType === 'window_load') {
          setFrameWindowLoaded(true);
        } else if (statusType === 'runtime_error' || statusType === 'unhandled_rejection') {
          const message = `App runtime error: ${statusDetail}`;
          setFrameFatal(message);
          emitDesktopEvent({
            code: 'desktop.viewer.runtime_error',
            severity: 'error',
            reason: statusType,
            metadata: {
              detail: statusDetail,
              entryPath: loadedEntryPath,
            },
          });
        }

        return;
      }

      const replyTargetOrigin = isOpaqueOrigin ? '*' : rawOrigin;

      if (
        typeof e.data !== 'object' ||
        e.data === null ||
        !('__dotuix' in e.data) ||
        (e.data as { __dotuix?: unknown }).__dotuix !== true
      ) {
        emitDesktopEvent({
          code: 'desktop.bridge.payload_rejected',
          severity: 'warn',
          reason: 'invalid_envelope',
        });
        return;
      }

      const { id, cmd, payload } = e.data as {
        id: number;
        cmd: string;
        payload?: Record<string, unknown>;
      };

      if (!Number.isInteger(id) || id <= 0) {
        emitDesktopEvent({
          code: 'desktop.bridge.payload_rejected',
          severity: 'warn',
          reason: 'invalid_id',
        });
        return;
      }

      if (!/^[a-z_][a-z0-9_]*$/i.test(cmd)) {
        emitDesktopEvent({
          code: 'desktop.bridge.payload_rejected',
          severity: 'warn',
          reason: 'invalid_command',
          metadata: {
            cmd,
          },
        });
        return;
      }

      if (
        payload !== undefined &&
        (typeof payload !== 'object' || payload === null || Array.isArray(payload))
      ) {
        emitDesktopEvent({
          code: 'desktop.bridge.payload_rejected',
          severity: 'warn',
          reason: 'invalid_payload',
        });
        return;
      }

      try {
        const result = await invoke(cmd, payload ?? {});
        iframeRef.current?.contentWindow?.postMessage(
          { __dotuix_reply: true, id, result },
          replyTargetOrigin,
        );
      } catch (err) {
        iframeRef.current?.contentWindow?.postMessage(
          { __dotuix_reply: true, id, error: String(err) },
          replyTargetOrigin,
        );
      }
    };

    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [state.status, loadedEntryPath, activeFrameSrc, pushFrameDiagnostic]);

  // ── Fetch db paths when a .uix is loaded ────────────────────────────────
  useEffect(() => {
    if (state.status === 'loaded') {
      invoke<{ state_path: string | null; data_path: string | null }>('get_db_paths')
        .then((p) => {
          setDbStatePath(p.state_path);
          setDbDataPath(p.data_path);
        })
        .catch(() => {});
    } else {
      setDbStatePath(null);
      setDbDataPath(null);
      setDbOpen(false);
    }
  }, [state.status]);

  // ── Automatic local-sync heartbeat for Sync Hub presence ────────────────
  // biome-ignore lint/correctness/useExhaustiveDependencies: heartbeat restarts on app/sync-toggle change only; reading live state inside is intentional.
  useEffect(() => {
    if (state.status !== 'loaded' || !state.autoSyncEnabled) return;

    let cancelled = false;
    let inFlight = false;

    const runSync = async () => {
      if (cancelled || inFlight) return;
      inFlight = true;

      try {
        await invoke('state_sync');
      } catch (error) {
        // Keep logs useful by rate-limiting repeated offline/unreachable errors.
        const now = Date.now();
        if (now - autoSyncLastErrorAtRef.current > 60_000) {
          console.warn('Background sync failed:', error);
          autoSyncLastErrorAtRef.current = now;
        }
      } finally {
        inFlight = false;
      }
    };

    void runSync();
    const intervalId = window.setInterval(() => {
      void runSync();
    }, AUTO_SYNC_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [
    state.status,
    state.status === 'loaded' ? state.appPath : '',
    state.status === 'loaded' ? state.autoSyncEnabled : false,
  ]);

  // ── File association: check if launched with a .uix path ─────────────────
  useEffect(() => {
    invoke<string | null>('get_initial_file').then((path) => {
      if (!path) return;
      void loadPath(path);
    });
  }, [loadPath]);

  // ── Menu + file-drop events from Tauri ───────────────────────────────────
  useEffect(() => {
    const unsubs: Array<() => void> = [];

    listen('menu-open-file', async () => {
      const s = stateRef.current;
      if (s.status === 'loaded') {
        try {
          const path = await invoke<string>('pick_uix_path');
          await invoke('open_uix_in_new_process', { path });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg !== 'No file selected') {
            setState({ status: 'error', message: msg });
          }
        }
        return;
      }

      if (s.status === 'idle' || s.status === 'error') {
        setState({ status: 'loading' });
        invoke<LoadResult>('pick_and_load_uix')
          .then((r) => applyLoadResult(r))
          .catch((err) => {
            const msg = err instanceof Error ? err.message : String(err);
            setState(
              msg === 'No file selected' ? { status: 'idle' } : { status: 'error', message: msg },
            );
          });
      }
    }).then((u) => unsubs.push(u));

    listen('menu-close-app', () => {
      if (stateRef.current.status === 'loaded') {
        invoke('close_uix').catch(() => {});
        setState({ status: 'idle' });
      }
    }).then((u) => unsubs.push(u));

    listen<{ name?: string; version?: string }>('menu-about-viewer', (event) => {
      const name = event.payload?.name ?? 'dotuix Viewer';
      const version = event.payload?.version ?? 'unknown';
      window.alert(`${name}\nVersion ${version}`);
    }).then((u) => unsubs.push(u));

    // Native file drag-drop (Tauri emits these automatically)
    listen<{ paths?: string[] }>('tauri://drag-drop', (event) => {
      const path = (event.payload.paths ?? []).find((p) => p.endsWith('.uix'));
      if (!path) return;
      setIsDragOver(false);
      void loadPath(path);
    }).then((u) => unsubs.push(u));

    listen('tauri://drag-enter', () => setIsDragOver(true)).then((u) => unsubs.push(u));
    listen('tauri://drag-leave', () => setIsDragOver(false)).then((u) => unsubs.push(u));

    // macOS file association: fired by RunEvent::Opened when a .uix is opened
    listen<string>('uix-file-opened', (event) => {
      const s = stateRef.current;
      if (s.status === 'loaded' && s.appPath === event.payload) {
        invoke('focus_main_window').catch(() => {});
        return;
      }
      void loadPath(event.payload);
    }).then((u) => unsubs.push(u));

    return () => unsubs.forEach((u) => u());
  }, [applyLoadResult, loadPath]);

  const openFile = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      const result = await invoke<LoadResult>('pick_and_load_uix');
      applyLoadResult(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setState(msg === 'No file selected' ? { status: 'idle' } : { status: 'error', message: msg });
    }
  }, [applyLoadResult]);

  const submitPin = useCallback(async () => {
    if (!pin.trim()) return;
    setPinError('');
    try {
      const result = await invoke<LoadResult>('unlock_with_pin', { pin });
      setPin('');
      applyLoadResult(result);
    } catch (err) {
      setPinError(err instanceof Error ? err.message : String(err));
    }
  }, [applyLoadResult, pin]);

  const closeApp = useCallback(() => setState({ status: 'idle' }), []);

  const openInNewWindow = useCallback(async () => {
    try {
      const path = await invoke<string>('pick_uix_path');
      await invoke('open_uix_in_new_process', { path });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg !== 'No file selected') {
        setState({ status: 'error', message: msg });
      }
    }
  }, []);

  // ── ⌘O / Ctrl+O keyboard shortcut to open a file ────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        const s = stateRef.current;
        if (s.status === 'idle' || s.status === 'error') {
          openFile();
          return;
        }
        if (s.status === 'loaded') {
          openInNewWindow();
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [openFile, openInNewWindow]);

  const toggleFullscreen = useCallback(() => invoke('toggle_fullscreen').catch(console.warn), []);

  const retryFrameLoad = useCallback(() => {
    pushFrameDiagnostic('viewer.retry_requested', 'User requested frame reload.');
    setFrameSrcOverride(null);
    setFrameReloadNonce((n) => n + 1);
  }, [pushFrameDiagnostic]);

  const copyFrameDiagnostics = useCallback(async () => {
    if (!loadedFrameKey) return;

    const lines: string[] = [
      `timestamp=${new Date().toISOString()}`,
      `entry=${loadedEntryPath}`,
      `source=${activeFrameSrc}`,
      `appPath=${loadedAppPath}`,
      `iframeLoaded=${String(frameIframeLoaded)}`,
      `bridgeBootstrapped=${String(frameBridgeBootstrapped)}`,
      `domContentLoaded=${String(frameDomLoaded)}`,
      `windowLoad=${String(frameWindowLoaded)}`,
      `fatal=${frameFatal ?? ''}`,
      'events:',
      ...frameDiagnostics.map(
        (item) => `- ${new Date(item.ts).toISOString()} ${item.stage} ${item.detail}`,
      ),
    ];

    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      pushFrameDiagnostic('viewer.diagnostics_copied', 'Copied diagnostics to clipboard.');
    } catch (err) {
      pushFrameDiagnostic('viewer.diagnostics_copy_failed', `Copy failed: ${String(err)}`);
    }
  }, [
    loadedFrameKey,
    loadedEntryPath,
    activeFrameSrc,
    loadedAppPath,
    frameIframeLoaded,
    frameBridgeBootstrapped,
    frameDomLoaded,
    frameWindowLoaded,
    frameFatal,
    frameDiagnostics,
    pushFrameDiagnostic,
  ]);

  // ── Loaded: viewer with professional toolbar ─────────────────────────────
  if (state.status === 'loaded') {
    const days = state.expires ? daysUntil(state.expires) : null;
    return (
      <div className="viewer-root">
        <div className="viewer-toolbar">
          <button className="toolbar-btn-home" onClick={closeApp} title="Close app (⌘W)">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path
                d="M7.5 2L4 6L7.5 10"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            Home
          </button>
          <span className="toolbar-sep" />
          <span className="toolbar-title">{state.manifestName}</span>
          <div className="toolbar-badges">
            {state.signed && (
              <span className="badge badge--signed">
                <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
                  <path
                    d="M1 4L3 6L7 2"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                Signed
              </span>
            )}
            <span
              className={`badge ${
                state.networkAllowed ? 'badge--network-on' : 'badge--network-off'
              }`}
              title={
                state.networkAllowed
                  ? 'Network access is enabled by this app manifest.'
                  : 'Network access is blocked by this app manifest.'
              }
            >
              {state.networkAllowed ? 'Network On' : 'Network Off'}
            </span>
            {state.autoSyncEnabled && (
              <span
                className="badge badge--signed"
                title="Local sync heartbeat is running automatically."
              >
                Auto Sync
              </span>
            )}
            {days !== null && (
              <span className={`badge ${days <= 7 ? 'badge--expires-warn' : 'badge--expires'}`}>
                {days > 0 ? `${days}d left` : 'Expired'}
              </span>
            )}
          </div>
          <div className="toolbar-actions">
            <button
              className="toolbar-icon-btn"
              onClick={openInNewWindow}
              title="Open another .uix file in a new window"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
                <rect
                  x="4"
                  y="7"
                  width="13"
                  height="13"
                  rx="2"
                  stroke="currentColor"
                  strokeWidth="1.5"
                />
                <path
                  d="M11 4h7a2 2 0 0 1 2 2v7"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
                <path
                  d="M10 14l10-10"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
            </button>
            <button
              className="toolbar-icon-btn"
              onClick={() => setDbOpen((o) => !o)}
              title="DB Viewer (diagnostics)"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
                <ellipse cx="12" cy="5" rx="9" ry="3" stroke="currentColor" strokeWidth="1.5" />
                <path
                  d="M3 5v14c0 1.657 4.03 3 9 3s9-1.343 9-3V5"
                  stroke="currentColor"
                  strokeWidth="1.5"
                />
                <path
                  d="M3 12c0 1.657 4.03 3 9 3s9-1.343 9-3"
                  stroke="currentColor"
                  strokeWidth="1.5"
                />
              </svg>
            </button>
            <button
              className="toolbar-icon-btn"
              onClick={toggleFullscreen}
              title="Full screen (Ctrl+⌘+F)"
            >
              <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
                <path
                  d="M1 4V1H4M9 1H12V4M12 9V12H9M4 12H1V9"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </div>
        </div>
        {activeFrameSrc ? (
          <iframe
            key={loadedFrameKey}
            ref={iframeRef}
            src={activeFrameSrc}
            className="viewer-frame"
            title={`${state.manifestName} · ${state.appPath}`}
            onLoad={() => {
              setFrameIframeLoaded(true);
              pushFrameDiagnostic('iframe.load', 'Iframe document load event fired.');
            }}
            onError={() => {
              const message = 'The viewer iframe failed to load the entry document.';
              pushFrameDiagnostic('iframe.error', message);

              if (startTempFileFallback('iframe_error', message)) {
                return;
              }

              setFrameFatal(message);
              emitDesktopEvent({
                code: 'desktop.viewer.iframe_load_failed',
                severity: 'error',
                reason: 'iframe_load_error',
                metadata: {
                  entryPath: state.entryPath,
                },
              });
            }}
          />
        ) : (
          <div className="viewer-frame-loading" role="status" aria-live="polite">
            <Spinner size={18} />
            <span>Preparing app view...</span>
          </div>
        )}
        {frameFatal && (
          <div className="viewer-diagnostics" role="alert">
            <div className="viewer-diagnostics-card">
              <h3>App page did not render</h3>
              <p>{frameFatal}</p>
              <div className="viewer-diagnostics-paths">
                <span>Entry:</span>
                <code>{state.entryPath}</code>
                <span>Source:</span>
                <code>{activeFrameSrc || '(preparing fallback source)'}</code>
              </div>
              <div className="viewer-diagnostics-signals">
                <span className={frameIframeLoaded ? 'ok' : 'bad'}>
                  iframe load: {frameIframeLoaded ? 'ok' : 'missing'}
                </span>
                <span className={frameBridgeBootstrapped ? 'ok' : 'bad'}>
                  bridge bootstrap: {frameBridgeBootstrapped ? 'ok' : 'missing'}
                </span>
                <span className={frameDomLoaded ? 'ok' : 'bad'}>
                  DOMContentLoaded: {frameDomLoaded ? 'ok' : 'missing'}
                </span>
                <span className={frameWindowLoaded ? 'ok' : 'bad'}>
                  window load: {frameWindowLoaded ? 'ok' : 'missing'}
                </span>
              </div>
              <div className="viewer-diagnostics-actions">
                <button className="start-secondary-btn" onClick={retryFrameLoad}>
                  Retry App Load
                </button>
                <button
                  className="start-secondary-btn"
                  onClick={() => {
                    void copyFrameDiagnostics();
                  }}
                >
                  Copy Diagnostics
                </button>
                <button className="toolbar-btn-home" onClick={closeApp}>
                  Back Home
                </button>
              </div>
              <ul className="viewer-diagnostics-log">
                {[...frameDiagnostics].reverse().map((item, index) => (
                  <li key={`${item.ts}-${index}`}>
                    <span>{new Date(item.ts).toLocaleTimeString()}</span>
                    <strong>{item.stage}</strong>
                    <em>{item.detail}</em>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
        {dbOpen && (
          <div className="db-overlay">
            <div className="db-overlay-header">
              <span>DB Viewer</span>
              <button className="db-overlay-close" onClick={() => setDbOpen(false)}>
                ✕
              </button>
            </div>
            <DbViewer statePath={dbStatePath} dataPath={dbDataPath} />
          </div>
        )}
      </div>
    );
  }

  // ── License required ─────────────────────────────────────────────────────
  if (state.status === 'license_required') {
    const { appName, appId, deviceId, uixPath } = state;
    return (
      <div className="shell">
        <div className="pin-card">
          <div className="pin-icon">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none">
              <rect
                x="3"
                y="11"
                width="18"
                height="11"
                rx="2"
                stroke="currentColor"
                strokeWidth="1.75"
              />
              <path
                d="M7 11V7a5 5 0 0 1 10 0v4"
                stroke="currentColor"
                strokeWidth="1.75"
                strokeLinecap="round"
              />
              <circle cx="12" cy="16.5" r="1.5" fill="currentColor" />
            </svg>
          </div>
          <h2 className="pin-title">{appName}</h2>
          <p className="pin-desc">This app requires a valid license to run.</p>
          <div className="license-device">
            <span className="license-device-label">Your device ID</span>
            <code className="license-device-id">{deviceId}</code>
            <button
              className="license-copy-btn"
              onClick={() => navigator.clipboard.writeText(deviceId)}
            >
              Copy
            </button>
          </div>
          <button
            className="pin-submit"
            onClick={async () => {
              try {
                await invoke('pick_and_install_license', { app_id: appId });
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                if (msg === 'No file selected') return;
                setState({ status: 'error', message: `License error: ${msg}` });
                return;
              }
              setState({ status: 'loading' });
              try {
                const result = await invoke<LoadResult>('load_uix', {
                  path: uixPath,
                });
                applyLoadResult(result);
              } catch (err) {
                setState({
                  status: 'error',
                  message: err instanceof Error ? err.message : String(err),
                });
              }
            }}
          >
            Browse for .uixlicense…
          </button>
          <button className="pin-cancel" onClick={() => setState({ status: 'idle' })}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  // ── PIN dialog ───────────────────────────────────────────────────────────
  if (state.status === 'pin_required') {
    return (
      <div className="shell">
        <div className="pin-card">
          <div className="pin-icon">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none">
              <rect
                x="5"
                y="11"
                width="14"
                height="10"
                rx="2"
                stroke="currentColor"
                strokeWidth="1.75"
              />
              <path
                d="M8 11V8a4 4 0 0 1 8 0v3"
                stroke="currentColor"
                strokeWidth="1.75"
                strokeLinecap="round"
              />
            </svg>
          </div>
          <h2 className="pin-title">{state.appName}</h2>
          <p className="pin-desc">Enter the PIN to open this app.</p>
          <input
            className="pin-input"
            type="password"
            inputMode="numeric"
            placeholder="• • • •"
            value={pin}
            onChange={(e) => {
              setPin(e.target.value);
              setPinError('');
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitPin();
            }}
          />
          {pinError && <p className="pin-error">{pinError}</p>}
          <button className="pin-submit" onClick={submitPin}>
            Unlock
          </button>
          <button
            className="pin-cancel"
            onClick={() => {
              setPin('');
              setPinError('');
              setState({ status: 'idle' });
            }}
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  // ── Loading overlay ───────────────────────────────────────────────────────
  if (state.status === 'loading') {
    return (
      <div className="shell">
        <div className="loading-overlay">
          <Spinner size={28} />
          <span className="loading-label">Opening…</span>
        </div>
      </div>
    );
  }

  // ── Home / idle / error ──────────────────────────────────────────────────
  return (
    <div className={`shell shell--home${isDragOver ? ' shell--dragover' : ''}`}>
      {isDragOver && (
        <div className="drag-overlay">
          <div className="drag-overlay-inner">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path
                d="M12 3v12M7 11l5 5 5-5"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path d="M5 19h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            <span>Drop to open</span>
          </div>
        </div>
      )}
      <div className="start-shell">
        <header className="start-header">
          <div className="start-brand-wrap">
            <div className="brand-icon">
              <BrandIcon />
            </div>
            <div className="start-brand-copy">
              <span className="start-brand-name">dotuix Viewer</span>
              <p className="start-brand-subtitle">Desktop workspace for executable documents</p>
            </div>
          </div>
          <button className="start-link-btn" onClick={openInNewWindow}>
            Open In New Window
          </button>
        </header>

        <div className="start-grid">
          <section className="start-hero">
            <p className="start-kicker">Home</p>
            <h1 className="start-title">Open and review UIX apps with a real desktop workflow.</h1>
            <p className="start-description">
              Start by opening a document, dragging one into this window, or jumping back into a
              recent project. dotuix Viewer keeps each app isolated while giving you fast
              multi-window navigation.
            </p>

            <div className="start-actions">
              <button className="open-btn" onClick={openFile}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                  <path
                    d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"
                    stroke="currentColor"
                    strokeWidth="1.75"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                Open UIX File
              </button>
              <button className="start-secondary-btn" onClick={openInNewWindow}>
                Open In Separate Window
              </button>
            </div>

            <div className="start-shortcuts">
              <span>Quick Open: ⌘O</span>
              <span>Drag and drop: enabled</span>
              <span>Multiple documents: enabled</span>
            </div>
          </section>

          <aside className="start-side-panel">
            <div className="start-side-header">
              <h2>Recent Files</h2>
              {recentFiles.length > 0 && (
                <button className="start-link-btn" onClick={clearRecentFiles}>
                  Clear
                </button>
              )}
            </div>

            {recentFiles.length === 0 ? (
              <div className="recent-empty-state">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
                  <path
                    d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5z"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  <path
                    d="M14 3v5h5"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                <p>No recent files yet.</p>
                <span>Your recently opened UIX documents will appear here.</span>
              </div>
            ) : (
              <ul className="recent-list">
                {recentFiles.map((path) => (
                  <li key={path} className="recent-item">
                    <button
                      className="recent-open-btn"
                      onClick={() => {
                        void loadPath(path);
                      }}
                    >
                      <span className="recent-name">{filenameFromPath(path)}</span>
                      <span className="recent-path">{path}</span>
                    </button>
                    <button
                      className="recent-remove-btn"
                      title="Remove from recent files"
                      onClick={() => removeRecentFile(path)}
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </aside>
        </div>

        {state.status === 'error' && (
          <div className="error-msg">
            <span>{state.message}</span>
            <button
              className="error-dismiss"
              onClick={() => setState({ status: 'idle' })}
              aria-label="Dismiss error"
            >
              ✕
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
