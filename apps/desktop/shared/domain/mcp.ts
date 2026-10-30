/**
 * MCP server configuration (REV-AGENT-CORE-004, extended in #272/273/274).
 *
 * Stored at `<deviaDir>/mcp-servers.json` (global scope) and inside the
 * project at `<project>/.devia/mcp-servers.json` (project scope). The
 * source of truth is Devia-owned; per-agent synchronisers materialise
 * each server into the agent's native config file using marker-based
 * merging so hand-edited entries the user added directly survive.
 *
 * Stdio-only in Phase 1 — HTTP/SSE transports come later.
 */

/** Devia agent id that can host an MCP server. Mirrors the 7 agents
 *  with documented MCP support today. */
export type McpAgentId =
  | 'claude'
  | 'codex'
  | 'gemini'
  | 'opencode'
  | 'cursor-agent'
  | 'copilot'
  | 'qwen'
  | 'grok'
  | 'pi';

export type McpScope = 'global' | 'project';

/** How the user obtained the server entry. Drives the catalog tab
 *  rendering and hints when surfacing install errors. */
export type McpSource = 'npm' | 'uvx' | 'binary' | 'manual';

export interface McpServerConfig {
  /** Stable user-defined id. Used in temp config files, audit logs,
   *  and the `__devia_managed` marker inside agent config files. */
  id: string;
  /** Display name for the UI. */
  name: string;
  /** Optional one-liner from the catalog entry, surfaced in the UI. */
  description?: string;
  /** Executable name or absolute executable path. No shell syntax. */
  command: string;
  /** Argv passed verbatim to the child. */
  args: string[];
  /** Static env values for the server. Subject to `allowedEnvKeys` filtering. */
  env?: Record<string, string>;
  /**
   * Allowlist of env keys propagated from the user's env to the MCP child.
   * `PATH`, `HOME`, `LD_PRELOAD`, etc. are NEVER propagated unless explicitly
   * listed. Empty / absent → no env inheritance at all.
   */
  allowedEnvKeys?: string[];
  /** When `false`, the server is loaded but skipped at launch time. */
  enabled: boolean;
  /**
   * Agents this server is materialised for. Empty array → server is
   * persisted in the catalog but written to no agent file (useful for
   * temporarily disabling a server without losing its config).
   *
   * Optional for back-compat — entries missing this field default to
   * `['claude']` to preserve the V1 behaviour (Claude-only).
   */
  agents?: McpAgentId[];
  /** Optional scope discriminator. Missing → 'global'. */
  scope?: McpScope;
  /** Where the entry came from. Missing → 'manual'. */
  source?: McpSource;
  /** ms timestamp; missing entries default to 0 in the renderer. */
  createdAt?: number;
  /** When true, the entry is protected from "Remove all" sweeps. */
  pinned?: boolean;
  /**
   * Codex-only tuning (emitted ONLY by the TOML writer; JSON-config agents
   * ignore it): overrides codex's default 10s MCP startup timeout. Devia's
   * bundled servers spawn a full Electron binary (`ELECTRON_RUN_AS_NODE`)
   * whose cold start can exceed 10s — codex then silently drops the server.
   */
  startupTimeoutSec?: number;
  /**
   * PI / Codex / OpenCode tool exposure. Controls whether the agent
   * declares the server's tools directly in the prompt or only on
   * demand (codemode / deferred).  See PI docs:
   *   direct   → declared like built-in tools (best for small, frequent sets)
   *   deferred → loaded via tool_search on demand (best for large servers)
   *   codemode → reachable only from codemode scripts (default)
   *   hidden   → registered but unreachable
   */
  exposure?: 'direct' | 'deferred' | 'codemode' | 'hidden';
  /**
   * Codex-only tuning (emitted ONLY by the TOML writer; JSON-config agents
   * ignore it): codex's default approval mode for this server's tools.
   * Codex's non-interactive `exec` auto-rejects approval prompts, so Devia's
   * own servers pin `'auto'` to stay callable headlessly.
   */
  defaultToolsApprovalMode?: 'auto' | 'prompt' | 'approve';
}

/** Renderer-facing summary — `env` values redacted to avoid token leaks. */
export interface McpServerView {
  id: string;
  name: string;
  description?: string;
  command: string;
  args: string[];
  enabled: boolean;
  agents: McpAgentId[];
  scope: McpScope;
  source: McpSource;
  pinned: boolean;
  /** Keys allowed in env — values never exposed to the renderer. */
  allowedEnvKeys?: string[];
  /** PI / agent tool exposure (direct / deferred / codemode / hidden). */
  exposure?: 'direct' | 'deferred' | 'codemode' | 'hidden';
}

/** Shape persisted at `<deviaDir>/mcp-servers.json`. */
export interface McpServersFile {
  servers: McpServerConfig[];
}

/** Result of a single mcp:install / mcp:remove call. */
export interface McpInstallResult {
  ok: boolean;
  /** Per-agent target paths the synchroniser touched. */
  affectedFiles: string[];
  /** Optional snapshot id (when wired) so the renderer can offer "Deshacer". */
  snapshotId?: string;
  /** Set when ok=false. */
  error?: string;
}

/** Output of a single mcp:probe call. */
export interface McpProbeResult {
  ok: boolean;
  /** Server `initialize` response.serverInfo.version, when present. */
  version?: string;
  /** Exit code from the spawn (only meaningful when ok=false). */
  code?: number;
  /** Captured stderr (capped) when the probe fails. */
  stderr?: string;
  /** Human-readable failure reason. */
  error?: string;
}

/**
 * Lightweight catalog entry — embedded in the renderer (no remote
 * fetch in Phase 1). Drives the "Catálogo" tab of the MCP modal.
 */
export interface McpCatalogEntry {
  /** Stable slug used as the default id when the user installs. */
  slug: string;
  name: string;
  description: string;
  source: McpSource;
  command: string;
  args: string[];
  /** Env keys the server requires (the user fills the values). */
  requiredEnvKeys?: string[];
  /** Default agents to check when the user opens the install dialog. */
  defaultAgents?: McpAgentId[];
  /** Optional URL for "more info". */
  docsUrl?: string;
}

/** Streamed when the registry changes (install/remove/sync). The
 *  renderer refreshes its counter + modal list on receipt. */
export interface McpListChangedEvent {
  servers: McpServerView[];
}
