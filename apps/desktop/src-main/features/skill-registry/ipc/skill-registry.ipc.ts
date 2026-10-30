import * as fs from 'node:fs';

import type { FeatureContext } from '../../../shared/feature';
import { IPC } from '../../../../shared/contracts/ipc-channels';
import type { BuildSkillRegistryUseCase } from '../application/build-registry.use-case';
import { watchSkillRegistry, type SkillRegistryWatchHandle } from '../infrastructure/skill-registry-watcher';

/**
 * IPC adapter for the Skill Registry feature (#269).
 *
 *   - `skillRegistry:status`   (invoke) → current snapshot, no write.
 *   - `skillRegistry:refresh`  (invoke) → force regenerate; returns the
 *     result discriminator (ok / no-skills / error).
 *   - `skillRegistry:watch`    (invoke) → attach/detach the watcher.
 *   - `skillRegistry:read`     (invoke) → read the rendered Markdown body
 *     so the renderer can display it in the existing SpecViewer dialog.
 *   - `skillRegistry:changed`  (send)   → streaming refresh event.
 *
 * Single live watcher per project. Switching projects closes the
 * previous handle and reopens — mirrors the pattern from #268.
 */
export function registerSkillRegistryIpc(
  ctx: FeatureContext,
  useCase: BuildSkillRegistryUseCase,
): void {
  let liveWatch: { handle: SkillRegistryWatchHandle; projectPath: string } | null = null;

  ctx.ipc.handle(IPC.skillRegistryStatus, (_e, projectPath: string) =>
    useCase.status(projectPath));

  ctx.ipc.handle(IPC.skillRegistryRefresh, (_e, projectPath: string) =>
    useCase.refresh(projectPath));

  ctx.ipc.handle(IPC.skillRegistryWatch, (_e, projectPath: string | null) => {
    if (liveWatch && liveWatch.projectPath === projectPath) return true as const;
    liveWatch?.handle.close();
    liveWatch = null;
    if (!projectPath) return true as const;
    const handle = watchSkillRegistry(projectPath, useCase, (snapshot) => {
      if (!snapshot) return;
      ctx.send('skillRegistry:changed', { projectPath, snapshot });
    });
    // Kick a first refresh on watch attach so the renderer sees the
    // current state without needing a separate status() call.
    void useCase.refresh(projectPath).then((result) => {
      if (result.reason === 'ok' && result.snapshot) {
        ctx.send('skillRegistry:changed', { projectPath, snapshot: result.snapshot });
      }
    });
    liveWatch = { handle, projectPath };
    return true as const;
  });

  ctx.ipc.handle(IPC.skillRegistryRead, (_e, projectPath: string) => {
    const snapshot = useCase.status(projectPath);
    if (!snapshot) return null;
    try {
      return fs.readFileSync(snapshot.registryPath, 'utf8');
    } catch {
      return null;
    }
  });
}
