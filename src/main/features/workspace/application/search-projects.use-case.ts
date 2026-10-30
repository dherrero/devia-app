import type { WorkspaceScanner } from '../domain/ports';
import type { ProjectRegistry } from '../../../shared/ports';
import type { ProjectEntry } from '../../../../shared/domain/project';

export class SearchProjectsUseCase {
  constructor(private readonly deps: {
    scanner: WorkspaceScanner;
    projects: ProjectRegistry;
  }) {}

  execute(query: string): ProjectEntry[] {
    return this.deps.scanner.search(query).map((entry) => ({
      name: entry.name,
      path: entry.path,
      isRunning: this.deps.projects.isRunning(entry.path),
      tech: entry.tech,
    }));
  }
}
