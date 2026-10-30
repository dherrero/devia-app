import * as path from 'node:path';

import type { McpServerConfig } from '../../../../shared/domain/mcp';
import type { UiToolName } from '../../../../shared/domain/ui-tools';

/**
 * Builds the bundled `devia-ui` MCP server config for one run. HOW it reaches
 * each agent is that agent's mapper's job (S-30); the name is historical.
 *
 * Unlike memory/kanban (identity per PROJECT), `--ui-dir` is per RUN — it
 * embeds the runId — so the config differs on every run, by design.
 */
export const UI_SERVER_ID = 'devia-ui';

/** The parts of Devia's harness `devia_skill` serves (S-30 T-356): skills and sub-agents. */
export interface UiServerHarness {
  /** Every directory Devia manages skills in, highest precedence first. */
  readonly skillsDirs?: readonly string[];
  /** Devia's sub-agent definitions directory. */
  readonly subagentsDir?: string;
  /**
   * `devia_send_file` (S-32): absolute folders a file may be sent from, and
   * the run's cwd that relative paths resolve against. Emitted ONLY when
   * `send_file` is advertised, so every other run's argv stays byte-identical.
   */
  readonly sendRoots?: readonly string[];
  readonly cwd?: string;
  /**
   * Folders nothing may be sent from even inside a send root — Devia's data
   * dir. Same rule as `sendRoots`: only emitted with `send_file`.
   */
  readonly denyRoots?: readonly string[];
}

/**
 * S-24's server id. Every project Devia ever ran in may still carry this
 * entry, pointing at a `server.js` that no longer exists; mappers retire it.
 */
export const LEGACY_ASK_SERVER_ID = 'devia-ask';

export class UiMcpInjector {
  /** Absolute path to the compiled stdio server (dist/main/...). */
  private serverEntry(): string {
    return path.join(__dirname, 'server.js');
  }

  private sendFileArgs(tools: readonly UiToolName[], harness: UiServerHarness): string[] {
    if (!tools.includes('send_file')) return [];
    return [
      ...(harness.sendRoots && harness.sendRoots.length > 0
        ? ['--send-roots', JSON.stringify(harness.sendRoots)]
        : []),
      ...(harness.cwd ? ['--cwd', harness.cwd] : []),
      ...(harness.denyRoots && harness.denyRoots.length > 0
        ? ['--deny-roots', JSON.stringify(harness.denyRoots)]
        : []),
    ];
  }

  /**
   * Build the devia-ui server config for one run. `uiDir` is the per-run
   * rendezvous directory the main process polls; `tools` is the advertised
   * subset resolved by the run policy.
   */
  serverConfig(
    uiDir: string,
    tools: readonly UiToolName[],
    harness: UiServerHarness = {},
  ): McpServerConfig {
    return {
      id: UI_SERVER_ID,
      name: 'Devia UI',
      description: 'Draw Devia interface cards (questions, plans, reviews) and wait for the user.',
      command: process.execPath,
      args: [
        this.serverEntry(),
        '--ui-dir',
        uiDir,
        '--tools',
        tools.join(','),
        ...(harness.skillsDirs ?? []).flatMap((dir) => ['--skills-dir', dir]),
        ...(harness.subagentsDir ? ['--subagents-dir', harness.subagentsDir] : []),
        ...this.sendFileArgs(tools, harness),
      ],
      env: { ELECTRON_RUN_AS_NODE: '1' },
      enabled: true,
      // Codex-only (TOML writer): see KanbanMcpInjector.serverConfig.
      startupTimeoutSec: 30,
      defaultToolsApprovalMode: 'auto',
      // Force PI to discover these tools as built-ins (not only via codemode).
      exposure: 'direct',
    };
  }
}
