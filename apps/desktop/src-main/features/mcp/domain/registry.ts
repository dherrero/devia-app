import type { McpServerConfig, McpServerView } from '../../../../shared/domain/mcp';

/**
 * In-memory MCP server registry (REV-AGENT-CORE-004).
 * Loaded once from `<deviaDir>/mcp-servers.json` at startup. Read-only;
 * re-scan replaces the catalog atomically.
 */
export class McpServerRegistry {
  private readonly servers: Map<string, McpServerConfig> = new Map();

  constructor(initial: readonly McpServerConfig[] = []) {
    for (const s of initial) this.servers.set(s.id, s);
  }

  set(servers: readonly McpServerConfig[]): void {
    this.servers.clear();
    for (const s of servers) this.servers.set(s.id, s);
  }

  /** All enabled servers, optionally filtered by an allowlist of ids. */
  enabled(allowedIds?: readonly string[]): McpServerConfig[] {
    const allowSet = allowedIds ? new Set(allowedIds) : null;
    const out: McpServerConfig[] = [];
    for (const s of this.servers.values()) {
      if (!s.enabled) continue;
      if (allowSet !== null && !allowSet.has(s.id)) continue;
      out.push(s);
    }
    return out;
  }

  /** Renderer-facing summary (env values redacted). */
  list(): McpServerView[] {
    return [...this.servers.values()].map(s => {
      const v: McpServerView = {
        id: s.id,
        name: s.name,
        command: s.command,
        args: s.args,
        enabled: s.enabled,
        agents: s.agents ?? ['claude'],
        scope: s.scope ?? 'global',
        source: s.source ?? 'manual',
        pinned: s.pinned ?? false,
        ...(s.description !== undefined && { description: s.description }),
      };
      if (s.allowedEnvKeys !== undefined) v.allowedEnvKeys = s.allowedEnvKeys;
      if (s.exposure !== undefined) v.exposure = s.exposure;
      return v;
    });
  }

  /** Returns the full McpServerConfig for an id, or null. Used by the
   *  install / remove use cases which need the agents[] + env. */
  get(id: string): McpServerConfig | null {
    return this.servers.get(id) ?? null;
  }

  /** All servers, regardless of `enabled` flag. */
  all(): McpServerConfig[] {
    return [...this.servers.values()];
  }

  /** Replace one entry (or append if missing). Returns true when the
   *  registry mutated (caller may want to persist + emit). */
  upsert(server: McpServerConfig): boolean {
    const previous = this.servers.get(server.id);
    this.servers.set(server.id, server);
    return JSON.stringify(previous) !== JSON.stringify(server);
  }

  /** Drop the entry by id. Returns true when present. */
  remove(id: string): boolean {
    return this.servers.delete(id);
  }

  size(): number { return this.servers.size; }
}
