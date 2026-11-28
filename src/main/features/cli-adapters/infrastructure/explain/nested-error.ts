/**
 * Digs the provider's error out of an agent's error text (S-54).
 *
 * Agents hand Devia errors as prose with the provider's JSON body inside
 * (`OpenAI API error (401): {"code":"invalid_api_key",...}`), as a whole JSON
 * line (`{"type":"error","name":"APIError","statusCode":401,...}`) or as JSON
 * encoded inside another JSON's `message`. This reads all three.
 *
 * Pure and total: anything it cannot read yields `null`, never an exception.
 */
export interface NestedError {
  readonly statusCode?: number;
  readonly code?: string;
  readonly message?: string;
  readonly type?: string;
  /** Lower-cased provider name taken from "<Provider> API error", when present. */
  readonly provider?: string;
}

const MAX_DEPTH = 3;

/** The first balanced `{...}` slice that starts at `from`, honouring strings. */
function balancedObject(text: string, from: number): string | null {
  let depth = 0;
  let inString = false;
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return text.slice(from, i + 1);
  }
  return null;
}

function parseObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  const slice = balancedObject(text, start);
  if (slice === null) return null;
  try {
    const value: unknown = JSON.parse(slice);
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);
const num = (v: unknown): number | undefined => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isInteger(n) && n >= 100 && n <= 599 ? n : undefined;
};

function read(obj: Record<string, unknown>, depth: number): NestedError {
  const envelope =
    obj['error'] !== null && typeof obj['error'] === 'object' ? (obj['error'] as Record<string, unknown>) : null;
  const src = envelope ?? obj;
  let message = str(src['message']) ?? str(obj['message']);
  let statusCode = num(src['statusCode']) ?? num(src['status']) ?? num(obj['statusCode']) ?? num(obj['status']);
  let code = str(src['code']);
  let type = str(src['type']);
  // A message that is itself JSON: read the inner one, keeping what we already have.
  if (message !== undefined && depth < MAX_DEPTH && message.trimStart().startsWith('{')) {
    const inner = parseObject(message);
    if (inner !== null) {
      const nested = read(inner, depth + 1);
      message = nested.message ?? message;
      statusCode = statusCode ?? nested.statusCode;
      code = code ?? nested.code;
      type = type ?? nested.type;
    }
  }
  return {
    ...(statusCode !== undefined && { statusCode }),
    ...(code !== undefined && { code }),
    ...(message !== undefined && { message }),
    ...(type !== undefined && { type }),
  };
}

export function extractNestedError(raw: string): NestedError | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try {
    const obj = parseObject(raw);
    if (obj === null) return null;
    const found = read(obj, 0);
    if (Object.keys(found).length === 0) return null;
    const provider = /\b([A-Za-z][\w.-]*)\s+API error\b/i.exec(raw)?.[1]?.toLowerCase();
    const prefixed = /API error\s*\((\d{3})\)/i.exec(raw)?.[1];
    const statusCode = found.statusCode ?? (prefixed !== undefined ? num(prefixed) : undefined);
    return {
      ...found,
      ...(statusCode !== undefined && { statusCode }),
      ...(provider !== undefined && { provider }),
    };
  } catch {
    return null;
  }
}

/**
 * Masks credentials that slipped into an error text. Keys the provider already
 * masked (`key_vwqb********MBi2`) are left alone.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, 'sk-…[redacted]')
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{20,}/gi, '$1 [redacted]');
}
