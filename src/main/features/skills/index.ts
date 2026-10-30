import type { Feature, FeatureContext } from '../../shared/feature';
import type {
  ConfigRepository,
  SkillListReader,
  SnapshotCapturer,
} from '../../shared/ports';
import { ListSkillsUseCase } from './application/list-skills.use-case';
import { InstallSkillsUseCase } from './application/install-skills.use-case';
import { RemoveSkillUseCase } from './application/remove-skill.use-case';
import { DiscoverSkillsUseCase } from './application/discover-skills.use-case';
import { SkillReader } from './infrastructure/skill-reader';
import { SkillCache } from './infrastructure/skill-cache';
import { SkillInstaller } from './infrastructure/skill-installer';
import { SkillDiscoverer } from './infrastructure/skill-discoverer';
import { registerSkillsIpc } from './ipc/skills.ipc';

export interface SkillsDeps {
  config: ConfigRepository;
  /** Optional — when set, install operations capture a snapshot for
   *  the "Deshacer" toast in the renderer (#270). Tests omit it. */
  snapshot?: SnapshotCapturer;
}

/**
 * Reader exposed via the `SkillListReader` port (cross-feature read).
 * Used by the skill-registry feature (#269) so it can scan the same
 * dirs without re-implementing the dedup/frontmatter logic.
 */
export interface SkillsFeature extends Feature {
  readonly reader: SkillListReader;
}

/**
 * Per-project + global skill manager — implemented entirely inside Devia.
 *
 * Pipeline:
 *   1. `SkillDiscoverer` shallow-clones the source into an OS temp dir
 *      and lists every SKILL.md so the renderer can show a multi-select.
 *   2. `SkillInstaller` extracts each picked skill into the shared cache
 *      under `~/.devia-app/skills/<owner-repo>/<skill-name>/`, then
 *      symlinks (or junctions / copies on Windows) the cached folder
 *      into each agent's project- or global-scope skills dir.
 *
 * Why no `npx skills` dependency: skills are flat folders with a single
 * `SKILL.md`; the heavy lifting is just clone → copy → symlink. Owning
 * the pipeline gives us one copy per (repo, skill) shared across every
 * project that installs it and lets the app work without `npx`/network
 * after the first clone.
 *
 * Renderer-side the project is identified by its workspace-relative path
 * (`ProjectEntry.path`); we resolve to absolute via `config` in every
 * use case before touching the filesystem.
 */
export function buildSkillsFeature(deps: SkillsDeps): SkillsFeature {
  const reader = new SkillReader();
  const discoverer = new SkillDiscoverer();
  const cache = new SkillCache(deps.config);
  const installer = new SkillInstaller(discoverer, cache, deps.snapshot);
  const list = new ListSkillsUseCase(reader, deps.config);
  const install = new InstallSkillsUseCase(installer, deps.config);
  const remove = new RemoveSkillUseCase(installer, deps.config);
  const discover = new DiscoverSkillsUseCase(discoverer);

  return {
    id: 'skills',
    reader,
    register(ctx: FeatureContext) {
      registerSkillsIpc(ctx, { list, install, remove, discover, discoverer });
    },
    onBeforeQuit() {
      discoverer.dispose();
    },
  };
}
