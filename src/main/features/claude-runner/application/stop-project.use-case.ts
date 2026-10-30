import type { ProjectRegistry } from '../../../shared/ports';

export class StopProjectUseCase {
  constructor(private readonly registry: ProjectRegistry) {}

  execute(projectName: string): true {
    this.registry.stopProject(projectName);
    return true;
  }
}
