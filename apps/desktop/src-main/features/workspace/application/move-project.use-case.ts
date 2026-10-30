import * as path from 'node:path';
import type { ProjectFileSystem } from '../domain/ports';
import type {
  ConfigRepository,
  ProjectRegistry,
  StateStore,
} from '../../../shared/ports';
import { resolveInsideWorkspace } from '../../../shared/workspace-paths';

export class MoveProjectUseCase {
  constructor(private readonly deps: {
    config: ConfigRepository;
    fileSystem: ProjectFileSystem;
    projects: ProjectRegistry;
    state: StateStore;
  }) {}

  execute(sourcePath: string, targetFolderPath: string): string {
    const { abs: absFrom, root } = resolveInsideWorkspace(this.deps.config, sourcePath);
    if (absFrom === root) throw new Error('No se puede mover la raíz del workspace');
    if (!this.deps.fileSystem.exists(absFrom)) throw new Error('El proyecto no existe');

    const absTarget = targetFolderPath
      ? resolveInsideWorkspace(this.deps.config, targetFolderPath).abs
      : root;
    if (!this.deps.fileSystem.exists(absTarget)) throw new Error('La carpeta destino no existe');

    const leaf = path.basename(sourcePath);
    const newRel = targetFolderPath ? `${targetFolderPath}/${leaf}` : leaf;

    if (newRel === sourcePath) return newRel;

    const runningDescendants = this.findRunningDescendants(sourcePath);
    if (runningDescendants.length > 0) {
      throw new Error('Hay procesos activos en el proyecto');
    }

    const { abs: absTo } = resolveInsideWorkspace(this.deps.config, newRel);
    if (this.deps.fileSystem.exists(absTo)) {
      throw new Error('Ya existe un proyecto con ese nombre en la carpeta destino');
    }

    this.deps.fileSystem.rename(absFrom, absTo);
    this.deps.projects.renamePrefix(sourcePath, newRel);
    this.deps.state.save();

    return newRel;
  }

  private findRunningDescendants(projectPath: string): string[] {
    const prefix = projectPath + '/';
    const matches: string[] = [];
    for (const record of this.deps.projects.values()) {
      if (!record.isRunning) continue;
      if (record.name === projectPath || record.name.startsWith(prefix)) {
        matches.push(record.name);
      }
    }
    return matches;
  }
}
