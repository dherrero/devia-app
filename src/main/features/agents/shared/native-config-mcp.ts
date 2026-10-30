import * as os from 'node:os';

import type { McpAgentId, McpServerConfig } from '../../../../shared/domain/mcp';
import { resolveAgentTarget } from '../../mcp/domain/agent-targets';
import { McpSyncWriter } from '../../mcp/infrastructure/mcp-sync-writer';

/**
 * S-24's server id. Every project Devia ever ran in may still carry it,
 * pointing at a `server.js` that no longer exists — each delivery retires it.
 */
const RETIRED_SERVER_IDS = ['devia-ask'];

export interface NativeConfigDelivery {
  /** The project config file written, or null when nothing could be written. */
  readonly file: string | null;
  /** Server ids now present in that file (empty on failure). */
  readonly deliveredServerIds: readonly string[];
}

/**
 * Delivers MCP servers to an agent that reads them from its OWN project config
 * (OpenCode `opencode.json`, Codex `.codex/config.toml`, Gemini/Qwen
 * `settings.json`, Cursor/Copilot `mcp.json`, Grok user settings) — the shared
 * base of every "native config" mapper (S-30 T-348).
 *
 * ONE write per run, carrying every server together. The previous design had
 * one injector per server (memory, kanban, ui) each writing the same file; a
 * prune-by-default merge made each write delete the others (fixed in #216 by
 * passing `prune: false`). Writing them together removes that class of bug by
 * construction. Entries the user added by hand are preserved by the
 * marker-merge writer; Devia entries no longer requested stay untouched
 * (`prune: false`) so a server delivered by another path is never deleted.
 *
 * The file lands in `cwd` — the CLI reads its project config from where it
 * runs, which for an isolated pane is the session worktree.
 */
export class NativeConfigMcpDelivery {
  constructor(
    private readonly writer: Pick<McpSyncWriter, 'write'> = new McpSyncWriter(),
    private readonly home: () => string = os.homedir,
  ) {}

  deliver(agentId: string, cwd: string, servers: readonly McpServerConfig[]): NativeConfigDelivery {
    const agent = agentId as McpAgentId;
    const target = resolveAgentTarget(agent, 'project', { home: this.home(), project: cwd });
    if (!target) return { file: null, deliveredServerIds: [] };
    try {
      const file = this.writer.write({
        agent,
        target,
        managed: servers,
        removedIds: RETIRED_SERVER_IDS,
        parentEnv: process.env,
        prune: false,
      });
      return { file, deliveredServerIds: servers.map((s) => s.id) };
    } catch (err: unknown) {
      // A silent failure here means the run has none of Devia's tools; the
      // caller turns the empty delivery into a plain-text fallback prompt.
      console.warn(
        `[devia:mcp] native MCP delivery failed for agent=${agentId} file=${target.file}:`,
        err instanceof Error ? err.message : String(err),
      );
      return { file: null, deliveredServerIds: [] };
    }
  }
}
