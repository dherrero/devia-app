import type { McpServerConfig } from '../../../../shared/domain/mcp';
import type { McpJsonEntryShape } from '../domain/agent-targets';

/**
 * Marker-based merge primitives for the per-agent MCP synchronisers
 * (#272). Each Devia-managed server entry inside an agent's config
 * file carries a marker so the synchroniser can update or remove the
 * entry without touching user-added entries.
 *
 * Two strategies cover all 7 supported agents:
 *
 *   1. JSON merge — every Devia entry carries a `__devia_managed:
 *      <serverId>` sibling. Gemini, Qwen, Cursor, Copilot use the
 *      `standard` shape (`command` / `args` / `env`); OpenCode uses its
 *      `opencode-local` shape (`type` / `command[]` / `environment`).
 *      The per-entry shape comes from the agent target (`jsonEntryShape`).
 *
 *   2. TOML merge — each Devia section is wrapped with
 *      `# devia-mcp-start <id>` / `# devia-mcp-end <id>` comment
 *      markers. Codex's `~/.codex/config.toml` lives here.
 *
 * Claude uses its own per-server file strategy (one file = one
 * server, no markers needed) so it doesn't go through this module.
 */

export const DEVIA_MANAGED_KEY = '__devia_managed';

/**
 * Devia's bundled servers. They are injected one at a time by their own
 * injectors and are never part of the MCP-manager catalog, so a catalog sync
 * must not prune them as "no longer listed" — only an explicit `removedIds`
 * entry removes one.
 */
export const BUNDLED_SERVER_IDS: ReadonlySet<string> = new Set(['devia-memory', 'devia-kanban', 'devia-ui']);
export const TOML_START_PREFIX = '# devia-mcp-start ';
export const TOML_END_PREFIX = '# devia-mcp-end ';

// ─── JSON ────────────────────────────────────────────────────────

/**
 * A merged entry, in whichever shape the target agent reads. Devia
 * writes one of two shapes (see `McpJsonEntryShape`); on read we only
 * care about the `__devia_managed` marker, so the map is typed loosely.
 */
type JsonServerEntry = Record<string, unknown>;

/**
 * Merge Devia-managed servers into the JSON file's `parentKey` map.
 * Existing entries WITHOUT the `__devia_managed` marker are preserved
 * verbatim (the user added them by hand). Existing managed entries
 * are overwritten unconditionally so the source of truth is always
 * the Devia catalog.
 *
 * - `removedIds` strips Devia-managed entries whose id is on the
 *   list — used by remove() and to clean stale leftovers when an
 *   agent is dropped from `server.agents`.
 *
 * Returns the mutated root object — the caller writes it to disk.
 */
export interface JsonMergeOptions {
  /** Top-level key under which mcpServers live ("mcpServers", "mcp",
   *  etc — see the per-agent target table). */
  parentKey: string;
  /** Servers to upsert into the parent map. */
  managed: ReadonlyArray<McpServerConfig>;
  /** Server ids that should be REMOVED from the parent map (if
   *  Devia-managed; never touches user-added entries). */
  removedIds?: ReadonlyArray<string>;
  /** Compose-time env (Devia merges `server.env` + filtered
   *  `parentEnv[allowedEnvKeys]`). */
  composeEnv: (s: McpServerConfig) => Record<string, string>;
  /** Per-entry shape. Defaults to `standard` (command/args/env). */
  entryShape?: McpJsonEntryShape;
  /**
   * Drop Devia-managed entries that are not in `managed` (default true — the
   * MCP-manager sync writes the whole catalog). A single-server injector MUST
   * pass false, or each injection deletes the servers the previous injector
   * just wrote (memory → ui → kanban left only kanban in the file).
   */
  prune?: boolean;
  /**
   * Write the `exposure` field. pi-only (it decides whether pi declares the
   * tools directly or behind codemode); other CLIs validate their server schema
   * and must never see it.
   */
  emitExposure?: boolean;
}

export function mergeJson(
  root: Record<string, unknown> | null,
  options: JsonMergeOptions,
): Record<string, unknown> {
  const out: Record<string, unknown> = root && typeof root === 'object' ? { ...root } : {};
  const existing = (out[options.parentKey] && typeof out[options.parentKey] === 'object')
    ? { ...(out[options.parentKey] as Record<string, JsonServerEntry>) }
    : {};

  // 1. Drop Devia-managed entries that are no longer in the catalog.
  const stillManaged = new Set(options.managed.map((s) => s.id));
  const explicitRemove = new Set(options.removedIds ?? []);
  const prune = options.prune ?? true;
  for (const [id, entry] of Object.entries(existing)) {
    const managedBy = (entry as JsonServerEntry)[DEVIA_MANAGED_KEY];
    if (managedBy === id || managedBy === 'devia') {
      const unlisted = prune && !stillManaged.has(id) && !BUNDLED_SERVER_IDS.has(id);
      if (unlisted || explicitRemove.has(id)) {
        delete existing[id];
      }
    }
  }

  // 2. Upsert each managed server. Hand-added entries with the same
  //    id get overwritten — Devia owns the namespace once you opt in.
  const shape = options.entryShape ?? 'standard';
  for (const s of options.managed) {
    existing[s.id] = buildJsonEntry(s, options.composeEnv(s), shape, options.emitExposure === true);
  }

  if (Object.keys(existing).length === 0) {
    delete out[options.parentKey];
  } else {
    out[options.parentKey] = existing;
  }
  return out;
}

/**
 * Build one server entry in the shape the target agent reads. The
 * `__devia_managed` marker is appended in both shapes so the next sync
 * can tell Devia-owned entries from hand-added ones.
 */
function buildJsonEntry(
  s: McpServerConfig,
  env: Record<string, string>,
  shape: McpJsonEntryShape,
  emitExposure: boolean,
): JsonServerEntry {
  if (shape === 'opencode-local') {
    // OpenCode's McpLocalConfig: `command` is the whole argv array and the
    // env key is `environment`. https://opencode.ai/config.json
    const entry: JsonServerEntry = {
      type: 'local',
      command: [s.command, ...s.args],
      [DEVIA_MANAGED_KEY]: s.id,
    };
    if (Object.keys(env).length > 0) entry.environment = env;
    return entry;
  }
  const entry: JsonServerEntry = {
    command: s.command,
    args: s.args,
    [DEVIA_MANAGED_KEY]: s.id,
  };
  if (Object.keys(env).length > 0) entry.env = env;
  if (emitExposure && s.exposure !== undefined) entry.exposure = s.exposure;
  return entry;
}

// ─── TOML (Codex) ────────────────────────────────────────────────

/**
 * Codex's config.toml has a flat list of `[mcp_servers.<id>]`
 * sections. We wrap each Devia-managed section with comment markers
 * so we can find and replace them on the next sync without parsing
 * a real TOML AST.
 *
 *   # devia-mcp-start github
 *   [mcp_servers.github]
 *   command = "npx"
 *   args = ["@modelcontextprotocol/server-github"]
 *   env = { GITHUB_TOKEN = "..." }
 *   # devia-mcp-end github
 *
 * Hand-edited sections without the markers are preserved verbatim.
 */
export function mergeToml(
  current: string,
  managed: ReadonlyArray<McpServerConfig>,
  composeEnv: (s: McpServerConfig) => Record<string, string>,
  removedIds: ReadonlyArray<string> = [],
): string {
  // 1. Strip every Devia-managed block from the current body. Greedy
  //    by id, anchored by the start/end markers we own.
  let stripped = current;
  const stripIds = new Set([
    ...managed.map((s) => s.id),
    ...removedIds,
  ]);
  for (const id of stripIds) {
    const re = new RegExp(
      `(?:^|\\r?\\n)${escapeRegex(TOML_START_PREFIX + id)}\\b[\\s\\S]*?${escapeRegex(TOML_END_PREFIX + id)}\\b[^\\n]*`,
      'g',
    );
    stripped = stripped.replace(re, '');
  }
  // Clean up runs of blank lines left behind.
  stripped = stripped.replace(/\n{3,}/g, '\n\n').trimEnd();

  // 2. Append fresh managed blocks. Ordering matches the catalog
  //    array so two snapshots in a row produce byte-identical output.
  if (managed.length === 0) return stripped + (stripped.length > 0 ? '\n' : '');

  const blocks = managed.map((s) => renderTomlBlock(s, composeEnv(s)));
  const head = stripped.length > 0 ? stripped + '\n\n' : '';
  return head + blocks.join('\n\n') + '\n';
}

function renderTomlBlock(s: McpServerConfig, env: Record<string, string>): string {
  const lines: string[] = [];
  lines.push(`${TOML_START_PREFIX}${s.id}`);
  lines.push(`[mcp_servers.${s.id}]`);
  lines.push(`command = ${tomlString(s.command)}`);
  lines.push(`args = [${s.args.map(tomlString).join(', ')}]`);
  if (Object.keys(env).length > 0) {
    const envEntries = Object.entries(env)
      .map(([k, v]) => `${tomlKey(k)} = ${tomlString(v)}`)
      .join(', ');
    lines.push(`env = { ${envEntries} }`);
  }
  // Codex-only tuning knobs (config-reference): startup timeout for slow
  // children and headless-safe tool approval. Only the TOML (codex) writer
  // emits them — the JSON-config agents have no equivalent keys.
  if (s.startupTimeoutSec !== undefined && Number.isFinite(s.startupTimeoutSec)) {
    lines.push(`startup_timeout_sec = ${Math.round(s.startupTimeoutSec)}`);
  }
  if (s.defaultToolsApprovalMode !== undefined) {
    lines.push(`default_tools_approval_mode = ${tomlString(s.defaultToolsApprovalMode)}`);
  }
  lines.push(`${TOML_END_PREFIX}${s.id}`);
  return lines.join('\n');
}

function tomlString(value: string): string {
  // Basic TOML string literal — escape backslashes and quotes; reject
  // control characters by replacing them with spaces (defensive).
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f]/g, ' ');
  return `"${escaped}"`;
}

function tomlKey(key: string): string {
  // A TOML bare-key is [A-Za-z0-9_-]+; otherwise quote.
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : tomlString(key);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
