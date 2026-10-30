import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Catalog of known THIRD-PARTY memory MCP servers (E-DSK-13 #322), so Devia's
 * isolation/awareness is provider-neutral instead of engram-only. Matching is a
 * case-insensitive substring check over the server's id + command + args — good
 * enough to recognise the common installs without a brittle exact match.
 */
export interface ExternalMemoryMcp {
  /** Stable id for messaging. */
  readonly id: string;
  /** Human label. */
  readonly label: string;
  /** Lowercase substrings; any match flags the server. */
  readonly matchers: readonly string[];
}

export const KNOWN_EXTERNAL_MEMORY_MCPS: readonly ExternalMemoryMcp[] = [
  { id: 'engram', label: 'engram', matchers: ['engram'] },
  {
    id: 'mcp-memory-service',
    label: 'mcp-memory-service (doobidoo)',
    matchers: ['mcp-memory-service', 'doobidoo'],
  },
  {
    id: 'mcp-server-memory',
    label: 'MCP memory server (official)',
    matchers: ['server-memory', '@modelcontextprotocol/server-memory', 'servers/src/memory'],
  },
  { id: 'mem0', label: 'mem0', matchers: ['mem0'] },
  { id: 'basic-memory', label: 'basic-memory', matchers: ['basic-memory'] },
];

/** Devia's own server — never flag it as a competing external memory. */
const DEVIA_OWN = 'devia-memory';

export interface McpServerLike {
  id?: string;
  command?: string;
  args?: readonly string[];
}

/**
 * Classify a single MCP server: returns the matched catalog entry, or null when
 * it isn't a known external memory MCP (or is Devia's own).
 */
export function classifyExternalMemory(server: McpServerLike): ExternalMemoryMcp | null {
  const haystack = [server.id ?? '', server.command ?? '', ...(server.args ?? [])]
    .join(' ')
    .toLowerCase();
  if (!haystack.trim()) return null;
  if (haystack.includes(DEVIA_OWN)) return null;
  for (const entry of KNOWN_EXTERNAL_MEMORY_MCPS) {
    if (entry.matchers.some((m) => haystack.includes(m))) return entry;
  }
  return null;
}

/**
 * Scan a project's `.mcp.json` for known external memory MCP servers. Pure I/O
 * with a defensive parser: any read/parse failure yields an empty list (the
 * caller treats "couldn't tell" as "none detected"). De-duplicated by catalog id.
 */
export function scanProjectMcpForMemory(projectAbs: string): ExternalMemoryMcp[] {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(projectAbs, '.mcp.json'), 'utf8');
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (parsed === null || typeof parsed !== 'object') return [];
  const servers = (parsed as Record<string, unknown>)['mcpServers'];
  if (servers === null || typeof servers !== 'object') return [];

  const found = new Map<string, ExternalMemoryMcp>();
  for (const [name, value] of Object.entries(servers as Record<string, unknown>)) {
    const v = (value ?? {}) as Record<string, unknown>;
    const hit = classifyExternalMemory({
      id: name,
      command: typeof v['command'] === 'string' ? v['command'] : '',
      args: Array.isArray(v['args']) ? (v['args'] as unknown[]).map(String) : [],
    });
    if (hit) found.set(hit.id, hit);
  }
  return [...found.values()];
}
