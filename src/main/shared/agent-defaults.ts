import { ensureClaudeDefaults } from './claude-defaults';
import { ensureCodexTrust } from './codex-defaults';

/**
 * Per-agent initial project configuration, applied when Devia creates (or
 * adopts) a project so every compatible agent can run there without manual
 * setup:
 *
 *   - Claude → `.claude/settings.local.json` permissions baseline
 *     ({@link ensureClaudeDefaults}).
 *   - Codex  → trusted entry in `$CODEX_HOME/config.toml` so the
 *     project-scoped `.codex/config.toml` (where Devia injects its MCP
 *     servers) actually loads ({@link ensureCodexTrust}).
 *
 * Gemini / OpenCode / Cursor / Copilot / Qwen need no bootstrap here: their
 * permissions are runtime argv flags and their MCP config is written by the
 * injectors when the agent is active.
 *
 * Each step is independently idempotent and best-effort — a failure in one
 * never blocks the others or project creation itself.
 */
export function ensureAgentDefaults(projectAbsPath: string): void {
  try {
    ensureClaudeDefaults(projectAbsPath);
  } catch (err: unknown) {
    console.warn(
      `[devia:agents] claude defaults failed for ${projectAbsPath}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
  ensureCodexTrust(projectAbsPath);
}
