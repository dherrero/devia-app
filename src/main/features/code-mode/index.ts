import type { McpServerConfig } from '../../../shared/domain/mcp';
import type { RunMode } from '../../../shared/domain/run-capabilities';
import { planCodeMode, type CodeModePlan } from './application/plan-code-mode';
import { codeModeProtocol } from './infrastructure/code-mode-protocol';
import { CodeModeMcpInjector } from './mcp-server/code-mode-mcp-injector';

export { CODE_MODE_SERVER_ID, codeModeRunDir, removeCodeModeRunDir } from './mcp-server/code-mode-mcp-injector';
export { CodeModeEventRelay } from './application/code-mode-event-relay';
export { codeModeProtocol } from './infrastructure/code-mode-protocol';
export type { CodeModePlan } from './application/plan-code-mode';

export interface CodeModeDeps {
  config: { deviaDir(): string };
}

export interface CodeModeRunArgs {
  userServers: readonly McpServerConfig[];
  agentId: string;
  mode: RunMode;
  runId: string;
}

export interface CodeModeFeatureBuilt {
  /** Per run: which of the user's MCP servers go behind the gateway (null = none, run untouched). */
  readonly codeMode: (args: CodeModeRunArgs) => CodeModePlan | null;
  readonly codeModeProtocol: typeof codeModeProtocol;
}

export function buildCodeModeFeature(deps: CodeModeDeps): CodeModeFeatureBuilt {
  const injector = new CodeModeMcpInjector(() => deps.config.deviaDir());
  return {
    codeMode: (args) => {
      try {
        return planCodeMode({ ...args, injector });
      } catch (err: unknown) {
        // A problem here must never stop an agent run: the servers simply stay direct.
        console.warn('[code-mode] gateway not offered to this run:', err instanceof Error ? err.message : String(err));
        return null;
      }
    },
    codeModeProtocol,
  };
}
