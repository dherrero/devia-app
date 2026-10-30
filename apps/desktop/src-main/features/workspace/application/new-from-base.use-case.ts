import * as path from 'node:path';
import type { BasesStore, ProjectFileSystem } from '../domain/ports';
import type { ConfigRepository } from '../../../shared/ports';
import type { NewFromBaseResult } from '../../../../shared/domain/base';

/**
 * Creates a new project from a base defined in `bases.json`. Mirrors the
 * agent-controler flow:
 *   1. Clone `base.repository` (or just `mkdir`) and reinit git.
 *   2. Apply `base.copy_from_folder` overlays, skipping missing sources.
 *   3. Drop the default `.claude/settings.local.json`.
 *   4. Commit everything as the first commit.
 *   5. Return the new project path + the optional `autoSetup` instruction so
 *      the renderer can dispatch it to the active CLI agent.
 */
export class NewFromBaseUseCase {
  constructor(private readonly deps: {
    config: ConfigRepository;
    fileSystem: ProjectFileSystem;
    bases: BasesStore;
  }) {}

  execute(baseName: string, name: string, parentPath: string): NewFromBaseResult {
    const { workspaceRoot } = this.deps.config.get();
    if (!workspaceRoot) {
      throw new Error('Workspace no configurado');
    }

    const map = this.deps.bases.read();
    const base = map[baseName];
    if (!base) {
      throw new Error(`Base "${baseName}" no encontrada`);
    }

    const trimmedName = name.trim();
    const fullPath = parentPath ? `${parentPath}/${trimmedName}` : trimmedName;
    const dst = path.join(workspaceRoot, fullPath);

    if (this.deps.fileSystem.exists(dst)) {
      throw new Error(`Ya existe un proyecto en "${fullPath}"`);
    }

    if (base.repository) {
      this.deps.fileSystem.gitCloneAndReinit(base.repository, dst);
    } else {
      this.deps.fileSystem.mkdirRecursive(dst);
      this.deps.fileSystem.gitInit(dst);
    }

    for (const entry of base.copy_from_folder ?? []) {
      this.deps.fileSystem.applyBaseCopyEntry(dst, entry);
    }

    this.deps.fileSystem.ensureAgentDefaults(dst);
    // Stage everything from the overlay + agent defaults. Repo-based bases
    // already have history from the clone; we add this as a follow-up commit.
    // For empty bases this is the first commit, matching the previous
    // "init from base" behaviour.
    try {
      this.deps.fileSystem.gitInitAndFirstCommit(dst, 'init from base');
    } catch {
      // Swallow: repo-based bases may have nothing to commit if the overlays
      // didn't change tracked files. Project creation still succeeded.
    }

    const result: NewFromBaseResult = { projectPath: fullPath };
    if (base.autoSetup) result.autoSetup = base.autoSetup;
    return result;
  }
}
