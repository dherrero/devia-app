/**
 * MCP feature (REV-AGENT-CORE-004).
 *
 * Owns the in-memory `McpServerRegistry` plus the startup loader and IPC
 * handler. The use case calls into `registry.enabled(allowedIds)` per run
 * and uses `writeTempMcpConfig` to materialise the Claude-compatible config
 * file.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Feature, FeatureContext } from '../../shared/feature';
import type { SnapshotCapturer } from '../../shared/ports';
import { McpServerRegistry } from './domain/registry';
import { loadMcpServers } from './infrastructure/loader';
import { McpConfigWatcher } from './infrastructure/mcp-config-watcher';
import { McpSyncWriter } from './infrastructure/mcp-sync-writer';
import { InstallMcpUseCase } from './application/install-mcp.use-case';
import { RemoveMcpUseCase } from './application/remove-mcp.use-case';
import { ProbeMcpUseCase } from './application/probe-mcp.use-case';
import { registerMcpManagementIpc } from './ipc/mcp.ipc';

export { McpServerRegistry } from './domain/registry';
export { writeTempMcpConfig, type TempMcpConfig } from './infrastructure/temp-config-writer';
export type { McpServerConfig, McpServerView, McpServersFile } from '../../../shared/domain/mcp';

const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * UC-FIX-015: sweep orphaned MCP temp-config files left behind by a crash or
 * missed cleanup. Called once at startup; best-effort (locked / missing files
 * are silently skipped).
 */
export function sweepStaleMcpTempFiles(deviaDir: string, olderThanMs = STALE_THRESHOLD_MS): void {
  const tmpDir = path.join(deviaDir, 'tmp');
  let removed = 0;
  try {
    const entries = fs.readdirSync(tmpDir);
    const cutoff = Date.now() - olderThanMs;
    for (const name of entries) {
      if (!name.startsWith('mcp-') || !name.endsWith('.json')) continue;
      const full = path.join(tmpDir, name);
      try {
        if (fs.statSync(full).mtime.getTime() < cutoff) {
          fs.unlinkSync(full);
          removed++;
        }
      } catch { /* best-effort — file may be locked or gone */ }
    }
  } catch { /* tmpDir may not exist — swallow */ }
  if (removed > 0) {
    console.warn(`[mcp] startup sweep removed ${removed} stale temp config file(s) from ${tmpDir}`);
  }
}

export interface McpFeatureBuilt {
  readonly feature: Feature;
  readonly registry: McpServerRegistry;
}

export interface McpFeatureDeps {
  deviaDir: () => string;
  /** Optional snapshot capturer (#270). When wired, install / remove
   *  capture the affected agent files BEFORE the mutation so the
   *  renderer can offer "Deshacer". */
  snapshot?: SnapshotCapturer;
}

export function buildMcpFeature(deps: McpFeatureDeps): McpFeatureBuilt {
  const registry = new McpServerRegistry();
  const writer = new McpSyncWriter();
  const install = new InstallMcpUseCase(registry, writer, deps.deviaDir, deps.snapshot);
  const remove = new RemoveMcpUseCase(registry, writer, deps.deviaDir, deps.snapshot);
  const probe = new ProbeMcpUseCase();

  function rescan(): void {
    const servers = loadMcpServers(deps.deviaDir());
    registry.set(servers);
  }

  // #274: watch mcp-servers.json so out-of-process edits (hand-edits, external
  // tools) reach the registry without a restart. Created in register() once
  // `ctx.send` is available; torn down in onBeforeQuit().
  let watcher: McpConfigWatcher | null = null;

  const feature: Feature = {
    id: 'mcp',
    register(ctx: FeatureContext) {
      // Populate the registry synchronously at registration — BEFORE the
      // renderer boots and the right-rail issues its first `mcp:list`. The
      // initial load used to live in `onReady`, which `main.ts` defers 1.5s
      // past `did-finish-load`; launching with a pinned project then read an
      // empty registry, so the MCP badge stayed at 0 until a project switch
      // re-ran the count against the by-then-populated registry. `rescan` is
      // a single synchronous JSON read, so there's no reason to defer it.
      rescan();
      // Read-side IPC kept inline; the management surface
      // (install/remove/probe) is registered via the dedicated adapter.
      ctx.ipc.handle('mcp:rescan', () => { rescan(); return registry.list(); });
      registerMcpManagementIpc(ctx, { registry, install, remove, probe });

      // #274: reload + push the fresh list on external edits so the badge and
      // the MCP manager update live. install/remove already emit their own
      // mcp:list-changed and only `rescan` reads the file (no write), so this
      // never echoes back into a write loop.
      watcher = new McpConfigWatcher(
        () => path.join(deps.deviaDir(), 'mcp-servers.json'),
        () => {
          rescan();
          ctx.send('mcp:list-changed', { servers: registry.list() });
        },
      );
      watcher.start();
    },
    async onReady() {
      sweepStaleMcpTempFiles(deps.deviaDir());
    },
    onBeforeQuit() {
      watcher?.stop();
      watcher = null;
    },
  };

  return { feature, registry };
}
