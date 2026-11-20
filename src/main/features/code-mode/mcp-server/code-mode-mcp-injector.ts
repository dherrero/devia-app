import * as fs from 'node:fs';
import * as path from 'node:path';

import type { McpServerConfig } from '../../../../shared/domain/mcp';
import type { RunMode } from '../../../../shared/domain/run-capabilities';

/**
 * Builds the bundled `devia-code-mode` MCP server config (S-50). Like the other
 * bundled servers, HOW it reaches each agent is that agent's mapper's job; this
 * only describes the server. It runs as a child node process (the Electron binary
 * with `ELECTRON_RUN_AS_NODE=1`, since a packaged app has no `node` on PATH).
 *
 * The MCP servers that live behind the gateway are written to a private file
 * rather than passed in argv: their `env` carries credentials, and argv is visible
 * to every process on the machine.
 */
export const CODE_MODE_SERVER_ID = 'devia-code-mode';

/** A run directory nobody cleaned (crash, killed app) is swept after this long. */
const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

const safeSegment = (s: string): string => s.replace(/[^A-Za-z0-9_.-]/g, '_');

/** `<deviaDir>/tmp/code-mode/<runId>`: the gateway's servers file and its events. */
export function codeModeRunDir(deviaDir: string, runId: string): string {
  return path.join(deviaDir, 'tmp', 'code-mode', safeSegment(runId));
}

/** Drops a run's servers file (it carries credentials) and its events. Best effort. */
export function removeCodeModeRunDir(deviaDir: string, runId: string): void {
  try {
    fs.rmSync(codeModeRunDir(deviaDir, runId), { recursive: true, force: true });
  } catch {
    // The age sweep catches whatever this misses.
  }
}

export interface CodeModeServerArgs {
  /** The user's MCP servers that sit behind the gateway for this run. */
  codeModeServers: readonly McpServerConfig[];
  agentId: string;
  mode: RunMode;
  runId: string;
  /** `"<server>.<tool>"` → the user's own read/write ruling. */
  writeOverrides?: Record<string, 'read' | 'write'>;
}

export class CodeModeMcpInjector {
  constructor(
    private readonly deviaDir: () => string,
    private readonly now: () => number = Date.now,
  ) {}

  /** Absolute path to the compiled stdio server (dist/main/...). */
  private serverEntry(): string {
    return path.join(__dirname, 'server.js');
  }

  serverConfig(args: CodeModeServerArgs): McpServerConfig {
    const deviaDir = this.deviaDir();
    this.sweepStale(path.join(deviaDir, 'tmp', 'code-mode'));

    const runDir = codeModeRunDir(deviaDir, args.runId);
    const eventsDir = path.join(runDir, 'events');
    fs.mkdirSync(eventsDir, { recursive: true, mode: 0o700 });
    const serversFile = path.join(runDir, 'servers.json');
    fs.writeFileSync(
      serversFile,
      JSON.stringify({ servers: args.codeModeServers, ...(args.writeOverrides && { writeOverrides: args.writeOverrides }) }),
      { mode: 0o600 },
    );
    if (process.platform !== 'win32') fs.chmodSync(serversFile, 0o600);

    return {
      id: CODE_MODE_SERVER_ID,
      name: 'Devia Code Mode',
      description: 'Runs scripts that orchestrate the project MCP servers set to code mode (devia-native).',
      command: process.execPath,
      args: [this.serverEntry(), '--servers-file', serversFile, '--events-dir', eventsDir],
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        DEVIA_CODE_MODE_MODE: args.mode,
        DEVIA_ACTIVE_AGENT_ID: args.agentId,
      },
      enabled: true,
      // Codex-only (TOML writer): see CodeGraphMcpInjector.serverConfig.
      startupTimeoutSec: 30,
      defaultToolsApprovalMode: 'auto',
      // The tools of this server must be callable without codemode / tool_search.
      exposure: 'direct',
    };
  }

  private sweepStale(root: string): void {
    try {
      const cutoff = this.now() - STALE_AFTER_MS;
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const dir = path.join(root, entry.name);
        if (fs.statSync(dir).mtimeMs < cutoff) fs.rmSync(dir, { recursive: true, force: true });
      }
    } catch {
      // No root yet, or a dir vanished underneath us: nothing to sweep.
    }
  }
}
