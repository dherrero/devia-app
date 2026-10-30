import type {
  GitInspector,
  ProjectRegistry,
} from '../../../shared/ports';
import type { StatusInfo } from '../../../../shared/domain/status';

export class GetStatusUseCase {
  constructor(private readonly deps: {
    registry: ProjectRegistry;
    git: GitInspector;
  }) {}

  execute(): StatusInfo {
    const projects = [];
    for (const record of this.deps.registry.values()) {
      projects.push({
        name: record.name,
        isRunning: record.isRunning,
        newSession: record.newSession,
        git: this.deps.git.info(record.name),
      });
    }
    return {
      runningCount: projects.filter((p) => p.isRunning).length,
      projects,
    };
  }
}
