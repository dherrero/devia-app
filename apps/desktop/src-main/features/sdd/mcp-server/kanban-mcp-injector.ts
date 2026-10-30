import * as path from 'node:path';

import type { McpServerConfig } from '../../../../shared/domain/mcp';

/**
 * Builds the bundled devia-kanban MCP server config (T5). HOW it reaches each
 * agent is that agent's mapper's job (S-30); the name is historical.
 *
 * The server runs as a child node process. In a packaged Electron app
 * there is no guaranteed `node` on PATH, so we spawn the Electron
 * binary itself with `ELECTRON_RUN_AS_NODE=1` (the standard trick) and
 * point argv at the compiled stdio server.
 */
const SERVER_ID = 'devia-kanban';
export class KanbanMcpInjector {
  constructor(private readonly deviaDir: () => string) {}

  /** Absolute path to the compiled stdio server (dist/main/...). */
  private serverEntry(): string {
    return path.join(__dirname, 'server.js');
  }

  /** Build the devia-kanban server config for a project. The
   *  marker-merge writer only consumes id/command/args/env. */
  serverConfig(projectAbs: string): McpServerConfig {
    return {
      id: SERVER_ID,
      name: 'Devia Kanban',
      description: 'Spec-driven kanban board for this project (devia-native SDD).',
      command: process.execPath,
      args: [this.serverEntry(), '--devia-dir', this.deviaDir(), '--project', projectAbs],
      env: { ELECTRON_RUN_AS_NODE: '1' },
      enabled: true,
      // Codex-only (TOML writer): the Electron child can cold-start past
      // codex's 10s default — it would then silently drop the server — and
      // headless `exec` auto-rejects approval prompts.
      startupTimeoutSec: 30,
      defaultToolsApprovalMode: 'auto',
      // Force PI to discover these tools as built-ins (not only via codemode).
      exposure: 'direct',
    };
  }
}
