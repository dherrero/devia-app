import * as path from 'node:path';
import type { McpAgentId, McpScope } from '../../../../shared/domain/mcp';

/**
 * Per-agent MCP target table (#272).
 *
 * Where each agent's CLI reads its MCP server entries from, and which
 * strategy the synchroniser uses to write them. Paths verified May 2026
 * — see `docs/mcp/01-cli-paths-audit.md` for the full
 * audit (T-49) with vendor-doc URLs per cell.
 *
 * Source per vendor:
 *   - Claude:   https://docs.claude.com/en/docs/claude-code/mcp
 *               https://docs.claude.com/en/docs/claude-code/settings
 *   - Codex:    https://developers.openai.com/codex/mcp
 *               https://developers.openai.com/codex/config-basic
 *   - Gemini:   https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md
 *   - OpenCode: https://opencode.ai/docs/mcp-servers/
 *               https://opencode.ai/docs/config/
 *   - Cursor:   https://cursor.com/docs/mcp
 *   - Copilot:  https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers
 *   - Qwen:     https://github.com/QwenLM/qwen-code (fork of Gemini CLI)
 */

export type McpMergeStrategy = 'json-merge' | 'toml-merge' | 'separate-file' | 'grok-array';

/**
 * Shape of each server entry inside a json-merge file.
 *
 *   - `standard`      → `{ command: string, args: string[], env? }` —
 *     Claude/Gemini/Qwen/Cursor/Copilot all read this.
 *   - `opencode-local`→ OpenCode's `McpLocalConfig`:
 *     `{ type: "local", command: string[], environment? }` (command is
 *     the WHOLE argv array, env key is `environment`). See
 *     https://opencode.ai/config.json ($defs.McpLocalConfig).
 *
 * The `__devia_managed` marker is appended as a sibling key in BOTH
 * shapes; OpenCode's loader decodes with `onExcessProperty: "ignore"`
 * so the unknown key is tolerated (it only trips editor JSON-schema
 * lint, never the runtime).
 */
export type McpJsonEntryShape = 'standard' | 'opencode-local';

export interface McpAgentTarget {
  /** Absolute path to the file the synchroniser writes/reads. */
  readonly file: string;
  /** Merge strategy. Drives which marker-merge helper handles it. */
  readonly strategy: McpMergeStrategy;
  /** For json-merge agents: the top-level key under which servers go. */
  readonly jsonParentKey?: string;
  /** For json-merge agents: the per-entry shape (defaults to `standard`). */
  readonly jsonEntryShape?: McpJsonEntryShape;
  /** For separate-file agents: the dir holding one file per server. */
  readonly perServerDir?: string;
}

/**
 * Resolve the target for `(agent, scope, project)`. Returns `null`
 * when the agent/scope combination is unsupported (e.g. project scope
 * for an agent whose CLI has no project-scope config file documented,
 * or any scope for agents without MCP support — DeepSeek, Qoder).
 */
export function resolveAgentTarget(
  agent: McpAgentId,
  scope: McpScope,
  ctx: { home: string; project?: string },
): McpAgentTarget | null {
  if (scope === 'project' && !ctx.project) return null;
  const project = ctx.project ?? '';

  switch (agent) {
    case 'claude':
      // User-scope MCP servers live INSIDE `~/.claude.json` (top-level
      // `mcpServers` key) — NOT in a separate `~/.claude/mcp.json` file
      // (that path is never read by Claude Code; was a long-standing
      // bug — T-50 of S-3). `~/.claude.json` also stores per-project
      // settings and other globals, so the merger MUST preserve every
      // unrelated top-level key.
      return scope === 'global'
        ? {
            file: path.join(ctx.home, '.claude.json'),
            strategy: 'json-merge',
            jsonParentKey: 'mcpServers',
          }
        : {
            file: path.join(project, '.mcp.json'),
            strategy: 'json-merge',
            jsonParentKey: 'mcpServers',
          };

    case 'codex':
      return scope === 'global'
        ? {
            file: path.join(ctx.home, '.codex', 'config.toml'),
            strategy: 'toml-merge',
          }
        : {
            file: path.join(project, '.codex', 'config.toml'),
            strategy: 'toml-merge',
          };

    case 'gemini':
      return scope === 'global'
        ? {
            file: path.join(ctx.home, '.gemini', 'settings.json'),
            strategy: 'json-merge',
            jsonParentKey: 'mcpServers',
          }
        : {
            file: path.join(project, '.gemini', 'settings.json'),
            strategy: 'json-merge',
            jsonParentKey: 'mcpServers',
          };

    case 'opencode':
      // OpenCode reads the project config from `<project>/opencode.json`
      // at the root (per https://opencode.ai/docs/config/) — NOT from
      // `<project>/.opencode/opencode.json`. The `.opencode/` directory
      // is for agents/commands/plugins/skills, not config (T-50).
      return scope === 'global'
        ? {
            file: path.join(ctx.home, '.config', 'opencode', 'opencode.json'),
            strategy: 'json-merge',
            jsonParentKey: 'mcp',
            jsonEntryShape: 'opencode-local',
          }
        : {
            file: path.join(project, 'opencode.json'),
            strategy: 'json-merge',
            jsonParentKey: 'mcp',
            jsonEntryShape: 'opencode-local',
          };

    case 'cursor-agent':
      // NOTE the Cursor CLI binary renamed `cursor-agent` → `agent`
      // (cursor.com/docs/cli/installation, 2026). The MCP file path is
      // unchanged.
      return scope === 'global'
        ? {
            file: path.join(ctx.home, '.cursor', 'mcp.json'),
            strategy: 'json-merge',
            jsonParentKey: 'mcpServers',
          }
        : {
            file: path.join(project, '.cursor', 'mcp.json'),
            strategy: 'json-merge',
            jsonParentKey: 'mcpServers',
          };

    case 'copilot':
      // GitHub Copilot CLI reads `~/.copilot/mcp-config.json` (NOT
      // `~/.copilot/mcp.json` — the `-config` suffix was missing in our
      // original implementation, T-50). The CLI has NO documented
      // project-scope config file; `.vscode/mcp.json` belongs to the
      // VS Code extension (and even uses a different JSON key,
      // `servers`), so we return `null` and the synchroniser skips it.
      if (scope === 'project') return null;
      return {
        file: path.join(ctx.home, '.copilot', 'mcp-config.json'),
        strategy: 'json-merge',
        jsonParentKey: 'mcpServers',
      };

    case 'qwen':
      return scope === 'global'
        ? {
            file: path.join(ctx.home, '.qwen', 'settings.json'),
            strategy: 'json-merge',
            jsonParentKey: 'mcpServers',
          }
        : {
            file: path.join(project, '.qwen', 'settings.json'),
            strategy: 'json-merge',
            jsonParentKey: 'mcpServers',
          };

    case 'grok':
      // grok-dev reads MCP servers ONLY from the user (global) settings —
      // `loadMcpServers()` = `loadUserSettings().mcp?.servers` (grok-cli
      // src/utils/settings.ts) — and the shape is a NESTED ARRAY
      // (`mcp.servers[]`), unlike the standard `mcpServers` object map. There
      // is no project-scope MCP file, so both scopes resolve to the same global
      // file; the `grok-array` strategy handles the array merge.
      return {
        file: path.join(ctx.home, '.grok', 'user-settings.json'),
        strategy: 'grok-array',
      };

    case 'pi':
      // Pi (withpi.ai) reads MCP servers from `~/.pi/agent/mcp.json` (global)
      // and `<project>/.pi/mcp.json` (project). Both use the standard
      // `mcpServers` object map shape. Project config is only loaded when the
      // project is trusted by Pi's trust manager; Devia writes it regardless
      // and Pi will pick it up on its next trust resolution.
      return scope === 'global'
        ? {
            file: path.join(ctx.home, '.pi', 'agent', 'mcp.json'),
            strategy: 'json-merge',
            jsonParentKey: 'mcpServers',
          }
        : {
            file: path.join(project, '.pi', 'mcp.json'),
            strategy: 'json-merge',
            jsonParentKey: 'mcpServers',
          };
  }
}

/**
 * Convenience list of every agent + scope target a "sync everything"
 * pass should touch for one server. The caller iterates these and
 * dispatches the right writer.
 */
export function targetsForServer(
  agents: ReadonlyArray<McpAgentId>,
  scope: McpScope,
  ctx: { home: string; project?: string },
): Array<{ agent: McpAgentId; target: McpAgentTarget }> {
  const out: Array<{ agent: McpAgentId; target: McpAgentTarget }> = [];
  for (const a of agents) {
    const t = resolveAgentTarget(a, scope, ctx);
    if (t) out.push({ agent: a, target: t });
  }
  return out;
}
