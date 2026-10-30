import * as fs from 'node:fs';
import * as path from 'node:path';

import type { Feature, FeatureContext } from '../../shared/feature';
import type { ConfigRepository, SddProjectPurger } from '../../shared/ports';
import type { McpServerConfig } from '../../../shared/domain/mcp';
import { KanbanStore } from './kanban/infrastructure/kanban-store';
import { BootstrapDetector } from './bootstrap/bootstrap';
import { NotificationStore } from './notifications/notification-store';
import { KanbanMcpInjector } from './mcp-server/kanban-mcp-injector';
import type { KanbanWatcher } from './watch/kanban-watcher';
import { registerSddIpc } from './ipc/sdd.ipc';

/**
 * Devia-native SDD feature (E-DSK-12).
 *
 * Replaces the spec-kit integration with an internal spec-driven
 * workflow whose state lives in devia's per-project cache
 * (`~/.devia-app/projects/<key>/kanban.json`) — never inside the
 * user's repo. Bundles:
 *
 *   - T2 first-contact bootstrap (new vs existing classification)
 *   - T3 spec:prepare / T9 spec:init prompt orchestration
 *   - T4 kanban board read + UI mutations
 *   - T5 cross-process MCP server injection (devia-kanban)
 *   - T6 block model + agent wake events
 *   - T7 notification centre (in-app + OS)
 *   - T10 commit ⇄ task reverse mapping
 *
 * The KanbanUseCase + watcher are created inside `register()` because
 * their hooks emit renderer events through the FeatureContext.
 */
export interface SddDeps {
  config: ConfigRepository;
}

export interface SddFeatureBuilt {
  readonly feature: Feature;
  /** Purges a project's SDD cache on trash (consumed by workspace). */
  readonly purger: SddProjectPurger;
  /** Builds the bundled devia-kanban MCP server config for a project, so
   *  the Claude runner can deliver it via `--mcp-config` (T5). */
  readonly kanbanMcpServer: (projectAbs: string) => McpServerConfig;
}

export function buildSddFeature(deps: SddDeps): SddFeatureBuilt {
  const deviaDir = (): string => deps.config.deviaDir();
  const store = new KanbanStore(deviaDir);
  const detector = new BootstrapDetector(deviaDir);
  const notifications = new NotificationStore(deviaDir);
  const injector = new KanbanMcpInjector(deviaDir);
  const watcherRef: { current: KanbanWatcher | null } = { current: null };

  // Remove the per-project board + bootstrap marker so recreating a
  // project at the same path is treated as first contact again. The
  // notification scrub is done renderer-side (notifications are keyed by
  // the renderer's relative path).
  const purger: SddProjectPurger = {
    purge(absProjectPath: string): void {
      watcherRef.current?.unwatch(absProjectPath);
      store.invalidate(absProjectPath);
      const dir = path.join(deviaDir(), 'projects', KanbanStore.keyForPath(absProjectPath));
      for (const file of ['kanban.json', 'bootstrap.json']) {
        try { fs.rmSync(path.join(dir, file), { force: true }); } catch { /* best-effort */ }
      }
    },
  };

  const feature: Feature = {
    id: 'sdd',
    register(ctx: FeatureContext) {
      registerSddIpc(ctx, {
        config: deps.config,
        store,
        detector,
        notifications,
        watcherRef,
      });
    },
    onBeforeQuit() {
      watcherRef.current?.unwatch();
    },
  };

  return {
    feature,
    purger,
    kanbanMcpServer: (projectAbs: string): McpServerConfig => injector.serverConfig(projectAbs),
  };
}

export { KanbanStore } from './kanban/infrastructure/kanban-store';
export { KanbanUseCase } from './kanban/application/kanban.use-case';
export { specFooter, parseSpecFooter, scanCommitLinks } from './commit/commit-footer';
