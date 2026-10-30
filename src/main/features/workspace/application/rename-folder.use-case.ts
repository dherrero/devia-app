import * as path from 'node:path';
import type { ProjectFileSystem } from '../domain/ports';
import type {
  ConfigRepository,
  ProjectRegistry,
  SessionStore,
  StateStore,
} from '../../../shared/ports';
import {
  resolveInsideWorkspace,
  validateLeafName,
} from '../../../shared/workspace-paths';

/**
 * Renames a folder (or any project directory). Refuses if any descendant
 * project is running — the user must stop them first, otherwise we'd leak
 * child processes pointing at a path that no longer exists. Migrates the
 * project registry keys and session files so sessions remain reachable
 * under the new path.
 */
export class RenameFolderUseCase {
  constructor(private readonly deps: {
    config: ConfigRepository;
    fileSystem: ProjectFileSystem;
    projects: ProjectRegistry;
    sessions: SessionStore;
    state: StateStore;
  }) {}

  execute(folderPath: string, newName: string): string {
    const leaf = validateLeafName(newName);
    const { abs: absFrom, root } = resolveInsideWorkspace(this.deps.config, folderPath);
    if (absFrom === root) throw new Error('No se puede renombrar la raíz del workspace');
    if (!this.deps.fileSystem.exists(absFrom)) throw new Error('La carpeta no existe');

    const parentRel = path.dirname(folderPath);
    const newRel = parentRel === '.' ? leaf : `${parentRel}/${leaf}`;

    const runningDescendants = this.findRunningDescendants(folderPath);
    if (runningDescendants.length > 0) {
      throw new Error('Hay procesos activos dentro de la carpeta');
    }

    const { abs: absTo } = resolveInsideWorkspace(this.deps.config, newRel);
    if (absTo === absFrom) return newRel;
    if (this.deps.fileSystem.exists(absTo)) {
      throw new Error('Ya existe una carpeta con ese nombre');
    }

    this.deps.fileSystem.rename(absFrom, absTo);
    this.deps.projects.renamePrefix(folderPath, newRel);
    this.deps.state.save();

    return newRel;
  }

  private findRunningDescendants(folderPath: string): string[] {
    const prefix = folderPath + '/';
    const matches: string[] = [];
    for (const record of this.deps.projects.values()) {
      if (!record.isRunning) continue;
      if (record.name === folderPath || record.name.startsWith(prefix)) {
        matches.push(record.name);
      }
    }
    return matches;
  }
}
