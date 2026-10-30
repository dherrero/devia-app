import type { ProjectFileSystem } from '../domain/ports';
import type { ConfigRepository } from '../../../shared/ports';
import {
  resolveInsideWorkspace,
  validateLeafName,
} from '../../../shared/workspace-paths';

/**
 * Creates a plain navigation folder under the workspace (no git init). Used
 * by the sidebar's "Carpeta" entry to group projects under a custom
 * hierarchy without making the folder a selectable project.
 */
export class NewFolderUseCase {
  constructor(private readonly deps: {
    config: ConfigRepository;
    fileSystem: ProjectFileSystem;
  }) {}

  execute(name: string, parentPath: string): string {
    const leaf = validateLeafName(name);
    resolveInsideWorkspace(this.deps.config, parentPath);
    const fullPath = parentPath ? `${parentPath}/${leaf}` : leaf;
    const { abs } = resolveInsideWorkspace(this.deps.config, fullPath);
    if (this.deps.fileSystem.exists(abs)) {
      throw new Error('Ya existe una carpeta con ese nombre');
    }
    this.deps.fileSystem.mkdirRecursive(abs);
    return fullPath;
  }
}
