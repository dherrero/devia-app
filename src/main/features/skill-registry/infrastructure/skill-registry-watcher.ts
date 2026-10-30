import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { BuildSkillRegistryUseCase } from '../application/build-registry.use-case';
import type { SkillRegistrySnapshot } from '../../../../shared/domain/skill-registry';

/**
 * Debounced fs.watch over every skill root the active project's agents
 * could load skills from. Pattern mirrors `spec-tree-watcher.ts` from
 * #268: 300 ms debounce, recursive when the platform supports it,
 * non-recursive fallback on Linux for missing dirs.
 *
 * The watcher is single-tenant per project; switching project closes
 * the previous handle and reopens against the new roots. The skill
 * roots themselves live in two places:
 *
 *   - project-scope, eight dirs under `<project>/`.
 *   - user-scope, eight dirs under `$HOME/` that every project sees.
 *
 * We watch all of them so installing a global skill via `npx skills`
 * outside Devia still refreshes the index of every active project.
 */

export interface SkillRegistryWatchHandle {
  current(): SkillRegistrySnapshot | null;
  close(): void;
}

const DEBOUNCE_MS = 300;

/**
 * Keep this list in sync with `SKILL_AGENT_MAP` inside the skills
 * feature. We re-declare instead of importing to keep the feature
 * boundary clean (skill-registry must not depend on skills internals);
 * the cost is one place to update when a new agent ships.
 */
const PROJECT_ROOTS: ReadonlyArray<string> = [
  '.claude/skills',
  '.agents/skills',
  '.cursor/skills',
  '.copilot/skills',
  '.codex/skills',
  '.qwen/skills',
  '.qoder/skills',
] as const;

function globalRoots(home: string): ReadonlyArray<string> {
  return [
    path.join(home, '.claude', 'skills'),
    path.join(home, '.codex', 'skills'),
    path.join(home, '.gemini', 'skills'),
    path.join(home, '.config', 'opencode', 'skills'),
    path.join(home, '.cursor', 'skills'),
    path.join(home, '.copilot', 'skills'),
    path.join(home, '.qwen', 'skills'),
    path.join(home, '.qoder', 'skills'),
  ];
}

export function watchSkillRegistry(
  projectPath: string,
  useCase: BuildSkillRegistryUseCase,
  onChange: (snapshot: SkillRegistrySnapshot | null) => void,
): SkillRegistryWatchHandle {
  let snapshot: SkillRegistrySnapshot | null = useCase.status(projectPath);
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  const watchers: fs.FSWatcher[] = [];

  const tick = (): void => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void useCase.refresh(projectPath).then((result) => {
        if (result.reason === 'ok' && result.snapshot) {
          snapshot = result.snapshot;
          onChange(snapshot);
        } else if (result.reason === 'no-skills') {
          snapshot = null;
          onChange(null);
        }
        // 'no-project' / 'error' are silent — the watcher keeps running,
        // a transient ENOENT during a rename storm will recover next tick.
      });
    }, DEBOUNCE_MS);
  };

  const safeWatch = (target: string): void => {
    if (!fs.existsSync(target)) return;
    try {
      const w = fs.watch(target, { recursive: true }, tick);
      watchers.push(w);
    } catch {
      try {
        const w = fs.watch(target, tick);
        watchers.push(w);
      } catch { /* best-effort */ }
    }
  };

  for (const rel of PROJECT_ROOTS) safeWatch(path.join(projectPath, rel));
  for (const abs of globalRoots(os.homedir())) safeWatch(abs);

  return {
    current: () => snapshot,
    close: () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = null;
      for (const w of watchers) {
        try { w.close(); } catch { /* swallow */ }
      }
      watchers.length = 0;
    },
  };
}
