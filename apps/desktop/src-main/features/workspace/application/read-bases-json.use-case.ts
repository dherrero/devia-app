import type { BasesStore } from '../domain/ports';

export interface ReadBasesJsonResult {
  text: string;
  filePath: string;
}

export class ReadBasesJsonUseCase {
  constructor(private readonly deps: { bases: BasesStore }) {}

  execute(): ReadBasesJsonResult {
    return {
      text: this.deps.bases.readText(),
      filePath: this.deps.bases.filePath(),
    };
  }
}
