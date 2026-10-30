/**
 * Small JSON helpers shared by the `json-event-stream` parsers (S-19 F1).
 * Pure, defensive: never throw on malformed agent output.
 */

export function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/** Parse a value that may already be an object or a JSON string. */
export function safeParseJson(value: unknown): unknown {
  if (value == null) return null;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  try { return JSON.parse(value); } catch { return null; }
}

export function stringifyContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  try { return JSON.stringify(value); } catch { return String(value); }
}

/**
 * Best-effort extraction of a human-readable message from an arbitrary error
 * payload (string, `{detail}`, `{message}`, `{error}`, or nested). Falls back
 * to `fallback` when nothing usable is found.
 */
export function extractErrorMessage(value: unknown, fallback: string): string {
  if (typeof value === 'string') {
    const parsed = safeParseJson(value);
    if (parsed && typeof parsed === 'object') {
      return extractErrorMessage(parsed, value);
    }
    return value;
  }
  if (isRecord(value)) {
    if (typeof value['detail'] === 'string' && value['detail']) return value['detail'];
    if (typeof value['message'] === 'string' && value['message']) {
      return extractErrorMessage(value['message'], value['message']);
    }
    if (typeof value['error'] === 'string' && value['error']) return value['error'];
    if (isRecord(value['error'])) return extractErrorMessage(value['error'], fallback);
  }
  return fallback;
}
