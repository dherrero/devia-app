import type { McpServerConfig } from '../../../../shared/domain/mcp';
import {
  grantClaudeMcpAccess,
  removeDeviaAskUserQuestionHook,
  revokeClaudeMcpAccess,
} from '../../../shared/claude-defaults';
import { writeTempMcpConfig } from '../../mcp/infrastructure/temp-config-writer';
import type { AgentRunPlan } from '../domain';

/** S-24's server: its Claude grant and hook are swept on every Claude run. */
const LEGACY_ASK_SERVER_ID = 'devia-ask';

export const ENTERPRISE_NOTICE =
  'Configuración MCP gestionada por la empresa: Devia no inyecta sus servidores MCP (kanban/memoria/preguntas) en este run; el agente usa la política MCP de la organización y no podrá abrir tarjetas de pregunta — preguntará en texto plano.';

export interface ClaudeMcpArtifacts {
  readonly args: string[];
  /** Server ids actually materialised (a failed temp write drops them all). */
  readonly mcpServerIds: readonly string[];
  cleanup(): void;
}

/**
 * Claude receives MCP servers through a per-run `--mcp-config` file — trusted
 * headlessly, unlike the project `.mcp.json`, which needs an interactive trust
 * prompt Devia's `-p` runtime cannot answer.
 *
 * - The grant is persisted in `.claude/settings.local.json` (the single source
 *   of truth for MCP permission, re-read on every `-p` run).
 * - `--strict-mcp-config` loads ONLY these servers (S-1 T-15: engram out).
 * - Under an enterprise-managed MCP config (T-88) Claude rejects BOTH flags,
 *   so neither is passed and the org's policy governs the run.
 * - Every run also sweeps the dead S-24 PreToolUse hook and `mcp__devia-ask`
 *   grant a project may still carry (Claude reads them from the run cwd).
 */
export function prepareClaudeMcp(
  plan: AgentRunPlan,
  servers: readonly McpServerConfig[],
  enterprise: boolean,
): ClaudeMcpArtifacts {
  try {
    removeDeviaAskUserQuestionHook(plan.cwd);
    revokeClaudeMcpAccess(plan.cwd, [LEGACY_ASK_SERVER_ID]);
  } catch (err: unknown) {
    console.warn('[devia:run] could not clean the legacy AskUserQuestion hook/grant:', err instanceof Error ? err.message : String(err));
  }
  if (enterprise) return { args: [], mcpServerIds: [], cleanup: () => undefined };

  const temp = writeTempMcpConfig([...servers], plan.deviaDir, process.env);
  const args: string[] = [];
  if (temp !== null) {
    args.push('--mcp-config', temp.path);
    try {
      grantClaudeMcpAccess(plan.cwd, servers.map((s) => s.id));
    } catch (err: unknown) {
      console.warn('[devia:run] could not persist MCP permission to .claude/settings.local.json:', err instanceof Error ? err.message : String(err));
    }
  }
  if (plan.harness.isolateExternalMcp) {
    args.push('--strict-mcp-config');
    console.log('[memory] external MCP isolated via --strict-mcp-config (engram hook residue expected)');
  }
  return {
    args,
    mcpServerIds: temp !== null ? servers.map((s) => s.id) : [],
    cleanup: () => temp?.cleanup(),
  };
}
