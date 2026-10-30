import type { ProjectFileSystem } from '../domain/ports';
import type {
  ConfigRepository,
  ProjectRegistry,
  SessionStore,
  PinnedStore,
  StateStore,
  SddProjectPurger,
} from '../../../shared/ports';
import { resolveInsideWorkspace } from '../../../shared/workspace-paths';

/**
 * Move a project or folder to the OS trash. When trashing a folder we cascade:
 * stop Claude on every descendant, drop their persisted sessions and forget
 * their registry entries, otherwise child processes would survive pointing at
 * a directory that no longer exists. Also drops dangling pins.
 */
export class TrashProjectUseCase {
  constructor(private readonly deps: {
    config: ConfigRepository;
    fileSystem: ProjectFileSystem;
    projects: ProjectRegistry;
    sessions: SessionStore;
    pinned: PinnedStore;
    state: StateStore;
    sddPurger?: SddProjectPurger;
  }) {}

  async execute(projectPath: string): Promise<true> {
    const { abs, root } = resolveInsideWorkspace(this.deps.config, projectPath);
    if (abs === root) throw new Error('No se puede borrar la raíz del workspace');
    if (!this.deps.fileSystem.exists(abs)) throw new Error('No existe');

    const prefix = projectPath + '/';
    const affected = this.deps.projects.paths().filter(
      (k) => k === projectPath || k.startsWith(prefix),
    );
    for (const key of affected) {
      this.deps.projects.stopProject(key);
      this.deps.sessions.deleteProjectSessions(key);
      this.purgeSdd(key);
      this.deps.projects.delete(key);
    }
    // Always try to drop sessions for the trashed root too, even if it had
    // no registry entry (folder with no opened projects, project never run).
    this.deps.sessions.deleteProjectSessions(projectPath);
    this.purgeSdd(projectPath);
    this.deps.pinned.removeMatching(projectPath);

    await this.deps.fileSystem.trash(abs);
    this.deps.state.save();
    return true;
  }

  /** Resolve a workspace-relative project key to absolute and clear its
   *  SDD cache (kanban + bootstrap marker). Best-effort. */
  private purgeSdd(projectKey: string): void {
    if (!this.deps.sddPurger) return;
    try {
      const { abs } = resolveInsideWorkspace(this.deps.config, projectKey);
      this.deps.sddPurger.purge(abs);
    } catch {
      // path no longer resolvable / workspace unset — nothing to purge
    }
  }
}
