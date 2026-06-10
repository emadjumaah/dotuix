type ObservabilitySeverity = 'info' | 'warn' | 'error';

type JsonPrimitive = string | number | boolean | null;
type JsonObject = Record<string, JsonPrimitive>;

export type DesktopEventCode =
  | 'desktop.trust_gate.blocked'
  | 'desktop.trust_gate.passed'
  | 'desktop.bridge.origin_rejected'
  | 'desktop.bridge.payload_rejected'
  | 'desktop.viewer.iframe_load_failed'
  | 'desktop.viewer.frame_init_timeout'
  | 'desktop.viewer.runtime_error'
  | 'desktop.sync.request_failed'
  | 'desktop.sync.request_succeeded';

export interface DesktopEvent {
  code: DesktopEventCode;
  severity: ObservabilitySeverity;
  appId?: string;
  reason?: string;
  metadata?: JsonObject;
}

const OBSERVABILITY_ENABLED = (() => {
  try {
    const raw = window.localStorage.getItem('dotuix.observability.enabled');
    return (raw ?? 'true').toLowerCase() !== 'false';
  } catch {
    return true;
  }
})();

function sinkBySeverity(
  severity: ObservabilitySeverity,
): typeof console.info | typeof console.warn | typeof console.error {
  if (severity === 'error') return console.error;
  if (severity === 'warn') return console.warn;
  return console.info;
}

export function emitDesktopEvent(event: DesktopEvent): void {
  if (!OBSERVABILITY_ENABLED) return;

  const payload = {
    schemaVersion: 1,
    component: 'desktop-viewer',
    ts: Date.now(),
    ...event,
  };

  sinkBySeverity(event.severity)(`[dotuix-obs] ${JSON.stringify(payload)}`);
}
