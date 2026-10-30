/**
 * Prompt-packs feature (REV-AGENT-CORE-003).
 *
 * Owns the in-memory `PromptPackRegistry` plus the startup scan + IPC handler
 * that lets the renderer list available packs. The registry is exported so
 * the claude-runner feature can resolve pack bodies for each run.
 */

import * as path from 'node:path';
import { app } from 'electron';
import type { Feature, FeatureContext } from '../../shared/feature';
import { PromptPackRegistry } from './domain/registry';
import { scanPromptPacks } from './infrastructure/scanner';
import type { PromptPack } from '../../../shared/domain/prompt-pack';

export { PromptPackRegistry } from './domain/registry';
export type { PromptPack, PromptPackSummary } from '../../../shared/domain/prompt-pack';

export interface PromptPacksFeatureBuilt {
  readonly feature: Feature;
  readonly registry: PromptPackRegistry;
}

export function buildPromptPacksFeature(deps: { deviaDir: () => string }): PromptPacksFeatureBuilt {
  const registry = new PromptPackRegistry();

  const userDir = path.join(deps.deviaDir(), 'prompt-packs');
  // Built-in packs ship under `app.getAppPath()/prompt-packs/` when available.
  // Falls back to a no-op directory in tests / Node mode (app may be undefined).
  let builtInDir = '';
  try { builtInDir = path.join(app.getAppPath(), 'prompt-packs'); }
  catch { builtInDir = ''; }

  function rescan(): void {
    const roots = [
      { dir: userDir,    source: 'user' as const },
      ...(builtInDir ? [{ dir: builtInDir, source: 'built-in' as const }] : []),
    ];
    const packs: PromptPack[] = scanPromptPacks(roots);
    registry.set(packs);
  }

  const feature: Feature = {
    id: 'prompt-packs',
    register(ctx: FeatureContext) {
      // List handler: returns summaries only — bodies stay in main process.
      ctx.ipc.handle('promptPacks:list', () => registry.list());
      ctx.ipc.handle('promptPacks:rescan', () => { rescan(); return registry.list(); });
    },
    async onReady() {
      rescan();
    },
  };

  return { feature, registry };
}
