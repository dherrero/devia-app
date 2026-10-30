import type { BasesStore } from '../domain/ports';

export class ListBasesUseCase {
  constructor(private readonly deps: { bases: BasesStore }) {}

  execute(): string[] {
    return Object.keys(this.deps.bases.read()).sort();
  }
}
