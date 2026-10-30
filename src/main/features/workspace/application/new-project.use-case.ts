import type { ProjectFileSystem } from '../domain/ports';
import type { ConfigRepository } from '../../../shared/ports';
import {
  resolveInsideWorkspace,
  validateLeafName,
} from '../../../shared/workspace-paths';

export class NewProjectUseCase {
  constructor(private readonly deps: {
    config: ConfigRepository;
    fileSystem: ProjectFileSystem;
  }) {}

  execute(name: string, parentPath: string): string {
    const leaf = validateLeafName(name);
    resolveInsideWorkspace(this.deps.config, parentPath);
    const fullPath = parentPath ? `${parentPath}/${leaf}` : leaf;
    const { abs } = resolveInsideWorkspace(this.deps.config, fullPath);
    this.deps.fileSystem.mkdirRecursive(abs);
    this.deps.fileSystem.gitInit(abs);
    this.deps.fileSystem.ensureAgentDefaults(abs);
    return fullPath;
  }
}
