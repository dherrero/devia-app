import type { FeatureContext } from '../../../shared/feature';
import { IPC } from '../../../../shared/contracts/ipc-channels';
import type {
  McpAgentId,
  McpScope,
  McpSource,
} from '../../../../shared/domain/mcp';
import type { McpServerRegistry } from '../domain/registry';
import type { InstallMcpUseCase } from '../application/install-mcp.use-case';
import type { RemoveMcpUseCase } from '../application/remove-mcp.use-case';
import type { ProbeMcpUseCase } from '../application/probe-mcp.use-case';

/**
 * IPC adapter for MCP management (#272/273/274).
 */
export interface McpIpcDeps {
  registry: McpServerRegistry;
  install: InstallMcpUseCase;
  remove: RemoveMcpUseCase;
  probe: ProbeMcpUseCase;
}

interface McpInstallIpcRequest {
  id: string;
  name: string;
  description?: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  allowedEnvKeys?: string[];
  agents: McpAgentId[];
  scope: McpScope;
  source: McpSource;
  projectPath?: string;
  enabled?: boolean;
}

export function registerMcpManagementIpc(ctx: FeatureContext, deps: McpIpcDeps): void {
  // Existing channels — kept here so all MCP IPC lives in one place.
  ctx.ipc.handle('mcp:list', () => deps.registry.list());

  ctx.ipc.handle(
    IPC.mcpInstall,
    (_e, req: McpInstallIpcRequest) => {
      try {
        const result = deps.install.execute(req);
        if (!result.ok) {
          console.error('[mcp:install] failed', {
            request: sanitizeMcpInstallRequest(req),
            result,
          });
        }
        ctx.send('mcp:list-changed', { servers: deps.registry.list() });
        return result;
      } catch (err) {
        console.error('[mcp:install] threw', {
          request: sanitizeMcpInstallRequest(req),
          error: err,
        });
        throw err;
      }
    },
  );

  ctx.ipc.handle(IPC.mcpRemove, (_e, id: string, projectPath?: string) => {
    const result = deps.remove.execute(id, projectPath);
    ctx.send('mcp:list-changed', { servers: deps.registry.list() });
    return result;
  });

  ctx.ipc.handle(IPC.mcpProbe, async (_e, id: string) => {
    const server = deps.registry.get(id);
    if (!server) {
      return { ok: false, error: `Servidor "${id}" no encontrado` };
    }
    return deps.probe.execute(server);
  });

  // sync (re-apply the whole catalog to every agent's native file) stays a
  // no-op stub: install/remove already re-write each agent file on mutation,
  // and out-of-process edits to mcp-servers.json are now picked up live by
  // McpConfigWatcher (#274). Returning ok keeps the renderer's "Resync todo"
  // button non-fatal.
  ctx.ipc.handle(IPC.mcpSync, () => ({ ok: true, affectedFiles: [] }));
}

function sanitizeMcpInstallRequest(
  req: McpInstallIpcRequest,
): Omit<McpInstallIpcRequest, 'env'> & { envKeys?: string[] } {
  const { env, ...rest } = req;
  return {
    ...rest,
    ...(env !== undefined && { envKeys: Object.keys(env) }),
  };
}
