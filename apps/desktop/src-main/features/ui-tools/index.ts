import type { McpServerConfig } from '../../../shared/domain/mcp';
import type { UiToolName } from '../../../shared/domain/ui-tools';
import { IPC } from '../../../shared/contracts/ipc-channels';
import type { Feature } from '../../shared/feature';
import { ConfirmationStore } from './infrastructure/confirmation-store';
import { uiToolCatalog } from './mcp-server/tool-registry';
import { UiMcpInjector, type UiServerHarness } from './mcp-server/ui-mcp-injector';

export { ConfirmationStore, normalizeAction } from './infrastructure/confirmation-store';
export type { ConfirmationGrant } from './infrastructure/confirmation-store';

export { UiMcpInjector, UI_SERVER_ID, LEGACY_ASK_SERVER_ID, type UiServerHarness } from './mcp-server/ui-mcp-injector';

export interface UiToolsFeature {
  /** Server config for one run; each agent's mapper decides how it travels. */
  uiMcpServer: (
    uiDir: string,
    tools: readonly UiToolName[],
    harness?: UiServerHarness,
  ) => McpServerConfig;
  /** S-25 F2.4: per-project "always allow" grants for `devia_confirm`. */
  confirmations: ConfirmationStore;
  /** IPC surface for the settings panel (S-25 F3.3). */
  feature: Feature;
}

/**
 * S-25: Devia's interface tools as a single MCP server (`devia-ui`).
 *
 * Stateless and IPC-less — it owns no store and registers no handlers, so like
 * the S-24 feature it replaces there is nothing to `register()`. Everything it
 * does happens per run, driven by `RunInstructionUseCase`.
 */
export function buildUiToolsFeature(deps: { deviaDir: () => string }): UiToolsFeature {
  const injector = new UiMcpInjector();
  const confirmations = new ConfirmationStore(deps.deviaDir);
  return {
    confirmations,
    feature: {
      id: 'ui-tools',
      register(ctx) {
        // Read-only catalog: the settings panel shows what each tool COSTS, and
        // the number has to come from the real advertised schema, not a table
        // that drifts the first time a description changes.
        ctx.ipc.handle(IPC.uiToolsCatalog, () => uiToolCatalog());
        ctx.ipc.handle(IPC.uiToolsGrants, (_e, projectPath: string) =>
          confirmations.list(String(projectPath ?? '')),
        );
        ctx.ipc.handle(IPC.uiToolsRevoke, (_e, projectPath: string, action?: string) => {
          const project = String(projectPath ?? '');
          if (!project) return;
          // No action → revoke everything for the project.
          if (action === undefined) confirmations.revokeAll(project);
          else confirmations.revoke(project, String(action));
        });
      },
    },
    uiMcpServer: (uiDir, tools, harness) => injector.serverConfig(uiDir, tools, harness),
  };
}
