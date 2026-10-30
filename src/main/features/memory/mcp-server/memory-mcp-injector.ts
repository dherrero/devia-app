import * as path from 'node:path';

import type { McpServerConfig } from '../../../../shared/domain/mcp';

/**
 * Builds the bundled `devia-memory` MCP server config. HOW it reaches each
 * agent (`--mcp-config`, a pi extension, OpenCode's per-run config, a native
 * config file) is that agent's mapper's job (S-30), so this only describes the
 * server. The name is historical: it no longer injects anything.
 *
 * The server runs as a child node process. In a packaged Electron app there is
 * no guaranteed `node` on PATH, so we spawn the Electron binary itself with
 * `ELECTRON_RUN_AS_NODE=1` and point argv at the compiled stdio server.
 */
const SERVER_ID = 'devia-memory';
export class MemoryMcpInjector {
  constructor(private readonly deviaDir: () => string) {}

  /** Absolute path to the compiled stdio server (dist/main/...). */
  private serverEntry(): string {
    return path.join(__dirname, 'server.js');
  }

  /** Build the devia-memory server config for a project. The marker-merge
   *  writer (and the runner's --mcp-config) only consume id/command/args/env
   *  plus the codex-only TOML tuning fields. `agentId` (S-2 F1.1) rides as
   *  DEVIA_ACTIVE_AGENT_ID so the out-of-process server can stamp who wrote. */
  serverConfig(projectAbs: string, agentId?: string): McpServerConfig {
    return {
      id: SERVER_ID,
      name: 'Devia Memory',
      description: 'Devia internal persistent memory for this project (devia-native).',
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
