import type { WorkspaceScanner, TechDetector } from '../domain/ports';
import type { ProjectRegistry } from '../../../shared/ports';
import type { ProjectEntry } from '../../../../shared/domain/project';

export class ListProjectsUseCase {
  constructor(private readonly deps: {
    scanner: WorkspaceScanner;
    tech: TechDetector;
    projects: ProjectRegistry;
  }) {}

  execute(subpath: string): ProjectEntry[] {
    return this.deps.scanner.listSubpath(subpath).map((name) => {
      const fullPath = subpath ? `${subpath}/${name}` : name;
      return {
        name,
        path: fullPath,
        isRunning: this.deps.projects.isRunning(fullPath),
        tech: this.deps.tech.detect(fullPath),
      };
    });
  }
}
