import { NotFoundError } from '@core';

export interface Repository<T extends { id: string }> {
  get(id: string): T;
  save(item: T): void;
  all(): T[];
}

export class InMemoryRepository<T extends { id: string }> implements Repository<T> {
  private readonly items = new Map<string, T>();

  get(id: string): T {
    const found = this.items.get(id);
    if (!found) throw new NotFoundError(id);
    return found;
  }

  save(item: T): void {
    this.items.set(item.id, item);
  }

  all(): T[] {
    return [...this.items.values()];
  }
}
