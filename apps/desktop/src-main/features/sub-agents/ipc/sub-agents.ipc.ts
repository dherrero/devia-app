import type { FeatureContext } from '../../../shared/feature';
import type { ConfigRepository } from '../../../shared/ports';
import { IPC } from '../../../../shared/contracts/ipc-channels';
import { resolveInsideWorkspace } from '../../../shared/workspace-paths';
import type { SubAgent } from '../../../../shared/domain/sub-agents';
import type { SubAgentReader } from '../infrastructure/sub-agent-reader';
import type { InstallSubAgentUseCase } from '../application/install-sub-agent.use-case';
import type { RemoveSubAgentUseCase } from '../application/remove-sub-agent.use-case';
import type { AutoImportSubAgentsUseCase } from '../application/auto-import.use-case';

/**
 * IPC adapter for the sub-agent manager (#275).
 *
 * The renderer sends workspace-RELATIVE project paths (that's what
 * `ProjectEntry.path` / `AppStateService.selectedProject()` carry).
 * Every use case touches the filesystem, so we resolve to an
 * absolute path here via `resolveInsideWorkspace` — the same guard
 * skills / MCP already use. The original relative path is
 * echoed back in `subAgents:changed` so the renderer's
 * `e.projectPath === selectedProject()` filter keeps matching.
 */
export interface SubAgentsIpcDeps {
  config: ConfigRepository;
  reader: SubAgentReader;
  install: InstallSubAgentUseCase;
  remove: RemoveSubAgentUseCase;
  autoImport: AutoImportSubAgentsUseCase;
}

export function registerSubAgentsIpc(
  ctx: FeatureContext,
  deps: SubAgentsIpcDeps,
): void {
  /** Resolve the renderer's relative path to absolute, or null when
   *  the workspace isn't configured / the path escapes it. */
  const toAbs = (relPath: string): string | null => {
    try {
      return resolveInsideWorkspace(deps.config, relPath).abs;
    } catch {
      return null;
    }
  };

  ctx.ipc.handle(IPC.subAgentsList, (_e, projectPath: string) => {
    const abs = toAbs(projectPath);
    return abs ? deps.reader.list(abs) : [];
  });

  ctx.ipc.handle(
    IPC.subAgentsInstall,
    (_e, projectPath: string, entry: SubAgent) => {
      const abs = toAbs(projectPath);
      if (!abs) {
        return { ok: false, affectedFiles: [], error: 'Workspace no configurado' };
      }
      const result = deps.install.execute(abs, entry);
      if (result.ok) {
        ctx.send('subAgents:changed', {
          projectPath,
          subAgents: deps.reader.list(abs),
        });
      }
      return result;
    },
  );

  ctx.ipc.handle(
    IPC.subAgentsRemove,
    (_e, projectPath: string, name: string) => {
      const abs = toAbs(projectPath);
      if (!abs) {
        return { ok: false, affectedFiles: [], error: 'Workspace no configurado' };
      }
      const result = deps.remove.execute(abs, name);
      if (result.ok) {
        ctx.send('subAgents:changed', {
          projectPath,
          subAgents: deps.reader.list(abs),
        });
      }
      return result;
    },
  );

  ctx.ipc.handle(
    IPC.subAgentsAutoImport,
    (_e, projectPath: string) => {
      const abs = toAbs(projectPath);
      if (!abs) return { imported: [], skipped: true };
      const result = deps.autoImport.execute(abs);
      if (result.imported.length > 0) {
        ctx.send('subAgents:changed', {
          projectPath,
          subAgents: deps.reader.list(abs),
        });
      }
      return result;
    },
  );
}
