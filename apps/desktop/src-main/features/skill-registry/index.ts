import type { Feature, FeatureContext } from '../../shared/feature';
import type { SkillListReader } from '../../shared/ports';
import { BuildSkillRegistryUseCase } from './application/build-registry.use-case';
import { registerSkillRegistryIpc } from './ipc/skill-registry.ipc';

export interface SkillRegistryDeps {
  /**
   * The skills-feature's reader, passed in via the composition root.
   * Sharing the reader (instead of re-walking the same dirs) keeps the
   * dedup + frontmatter logic centralised in one place.
   */
  reader: SkillListReader;
}

export interface SkillRegistryFeature extends Feature {
  /**
   * Exposed so other features (skills install/remove, agent runner)
   * can trigger an inline refresh without going through IPC.
   */
  readonly useCase: BuildSkillRegistryUseCase;
}

/**
 * Skill registry feature (#269) — per-project `.devia/skill-registry.md`
 * index plus the streaming watcher that keeps it fresh.
 *
 * The feature does NOT depend on the skills feature directly: it
 * receives the same `SkillReader` instance via constructor so they
 * share the agent-dir scanning logic without crossing the feature
 * boundary. See CLAUDE.md "Feature isolation".
 */
export function buildSkillRegistryFeature(deps: SkillRegistryDeps): SkillRegistryFeature {
  const useCase = new BuildSkillRegistryUseCase(deps.reader);

  return {
    id: 'skill-registry',
    useCase,
    register(ctx: FeatureContext) {
      registerSkillRegistryIpc(ctx, useCase);
    },
  };
}
