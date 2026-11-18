import * as path from 'node:path';

import type { McpServerConfig } from '../../../../shared/domain/mcp';

/**
 * Builds the bundled `devia-code-graph` MCP server config. HOW it reaches each
 * agent (`--mcp-config`, a pi extension, OpenCode's per-run config, a native
 * config file) is that agent's mapper's job (S-30), so this only describes the
 * server — exactly like `MemoryMcpInjector`.
 *
 * The server runs as a child node process. In a packaged Electron app there is
 * no guaranteed `node` on PATH, so we spawn the Electron binary itself with
 * `ELECTRON_RUN_AS_NODE=1` and point argv at the compiled stdio server.
 */
export const CODE_GRAPH_SERVER_ID = 'devia-code-graph';

export class CodeGraphMcpInjector {
  constructor(private readonly deviaDir: () => string) {}

  /** Absolute path to the compiled stdio server (dist/main/...). */
  private serverEntry(): string {
    return path.join(__dirname, 'server.js');
  }

  /** Build the devia-code-graph server config for a project (or a worktree
   *  with its own graph). `agentId` rides as DEVIA_ACTIVE_AGENT_ID, as for
   *  devia-memory. */
  serverConfig(projectAbs: string, agentId?: string): McpServerConfig {
    return {
      id: CODE_GRAPH_SERVER_ID,
      name: 'Devia Code Graph',
      description: 'Devia code knowledge graph of this project: symbols, callers, callees and impact (devia-native).',
      command: process.execPath,
      args: [this.serverEntry(), '--devia-dir', this.deviaDir(), '--project', projectAbs],
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        ...(agentId !== undefined && { DEVIA_ACTIVE_AGENT_ID: agentId }),
      },
      enabled: true,
      // Codex-only (TOML writer): see KanbanMcpInjector.serverConfig.
      startupTimeoutSec: 30,
      defaultToolsApprovalMode: 'auto',
      // Force PI to discover these tools as built-ins (not only via codemode).
      exposure: 'direct',
    };
  }
}
