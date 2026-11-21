import type { McpInstallResult } from '../../../../shared/domain/mcp';
import type { McpServerRegistry } from '../domain/registry';
import type { InstallMcpUseCase } from './install-mcp.use-case';

/**
 * Switches one installed MCP server between "direct" (the agent sees its tools) and
 * "code mode" (the agent reaches it only through `devia-code-mode` scripts), S-50.
 *
 * It goes through the install use case on purpose: the exposure decides whether the
 * server is written to each agent's native config, so the switch has to re-sync those
 * files, and the registry already holds everything (credentials included) the install
 * needs, so nothing is asked of the renderer, which only ever sees redacted views.
 */
export class SetMcpExposureUseCase {
  constructor(
    private readonly registry: McpServerRegistry,
    private readonly install: InstallMcpUseCase,
  ) {}

  execute(id: string, exposure: 'direct' | 'codemode', projectPath?: string): McpInstallResult {
    const server = this.registry.get(id);
    if (!server) return { ok: false, affectedFiles: [], error: `Server "${id}" not found` };
    const scope = server.scope ?? 'global';
    if (scope === 'project' && !projectPath) {
      return { ok: false, affectedFiles: [], error: 'projectPath is required for a project-scoped server' };
    }
    return this.install.execute({
      id: server.id,
      name: server.name,
      command: server.command,
      args: server.args,
      agents: server.agents ?? ['claude'],
      scope,
      source: server.source ?? 'manual',
      enabled: server.enabled,
      exposure,
      ...(server.description !== undefined && { description: server.description }),
      ...(server.env !== undefined && { env: server.env }),
      ...(server.allowedEnvKeys !== undefined && { allowedEnvKeys: server.allowedEnvKeys }),
      ...(projectPath !== undefined && { projectPath }),
    });
  }
}
