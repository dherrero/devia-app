/** The fields of an ACP tool call the naming/policy code reads (a structural subset of the SDK type). */
export interface AcpToolCallLike {
  readonly toolCallId: string;
  readonly title?: string | null;
  readonly kind?: string | null;
  readonly rawInput?: unknown;
  readonly _meta?: unknown;
}

const MCP_PREFIX = 'mcp__';
const SEPARATORS = ['_', '.', '/'] as const;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

function candidates(call: AcpToolCallLike): string[] {
  const out: string[] = [];
  if (typeof call.title === 'string' && call.title.length > 0) out.push(call.title);
  for (const source of [asRecord(call.rawInput), asRecord(call._meta)]) {
    for (const key of ['name', 'tool', 'toolName']) {
      const value = source?.[key];
      if (typeof value === 'string' && value.length > 0) out.push(value);
    }
  }
  return out;
}

function canonicalise(candidate: string, serverIds: readonly string[]): string | undefined {
  if (candidate.startsWith(MCP_PREFIX)) {
    const rest = candidate.slice(MCP_PREFIX.length);
    if (serverIds.some((id) => rest.startsWith(`${id}__`))) return candidate;
  }
  const byLength = [...serverIds].sort((a, b) => b.length - a.length);
  for (const id of byLength) {
    for (const sep of SEPARATORS) {
      const prefix = `${id}${sep}`;
      if (candidate.startsWith(prefix) && candidate.length > prefix.length) {
        return `${MCP_PREFIX}${id}__${candidate.slice(prefix.length)}`;
      }
    }
  }
  return undefined;
}

export function defaultToolName(call: AcpToolCallLike, serverIds: readonly string[]): string {
  for (const candidate of candidates(call)) {
    const mcp = canonicalise(candidate, serverIds);
    if (mcp) return mcp;
  }
  return call.title ?? call.kind ?? 'tool';
}
