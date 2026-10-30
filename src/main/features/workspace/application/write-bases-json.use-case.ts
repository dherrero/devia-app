import type { BasesStore } from '../domain/ports';

export class WriteBasesJsonUseCase {
  constructor(private readonly deps: { bases: BasesStore }) {}

  execute(text: string): { count: number } {
    const map = this.deps.bases.writeText(text);
    return { count: Object.keys(map).length };
  }
}
