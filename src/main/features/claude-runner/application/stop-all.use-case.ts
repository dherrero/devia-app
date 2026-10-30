import type { ProjectRegistry } from '../../../shared/ports';

export class StopAllUseCase {
  constructor(private readonly registry: ProjectRegistry) {}

  execute(): string[] {
    return this.registry.stopAll();
  }
}
