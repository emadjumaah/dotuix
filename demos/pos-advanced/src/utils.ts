/** Parse a UIX record body (may be a JSON string or plain object). */
export function bodyOf<T = Record<string, unknown>>(record: {
  body: unknown;
}): T {
  if (typeof record.body === 'string') return JSON.parse(record.body) as T;
  return (record.body ?? {}) as T;
}

/** Format a number as QAR currency. */
export function qar(n: number): string {
  return `QAR ${n.toFixed(2)}`;
}

/** Format an ISO date string to "21 May · 14:30". */
export function fmtTime(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })} · ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
}

/** Return 1–2 uppercase initials from a name. */
export function initials(name: string): string {
  return name
    .split(' ')
    .map((w) => w[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase();
}
