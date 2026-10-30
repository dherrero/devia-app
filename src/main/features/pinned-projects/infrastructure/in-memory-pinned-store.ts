import type { PinnedStore } from '../../../shared/ports';

export class InMemoryPinnedStore implements PinnedStore {
  private pinned: string[] = [];

  list(): string[] { return this.pinned; }

  /**
   * Replaces the list atomically — caller (use case) is responsible for
   * persisting. Dedupes and refuses non-string entries so a malformed
   * payload can't corrupt state.json.
   */
  set(paths: unknown[]): string[] {
    const seen = new Set<string>();
    const next: string[] = [];
    for (const p of paths) {
      if (typeof p !== 'string' || !p || seen.has(p)) continue;
      seen.add(p);
      next.push(p);
    }
    this.pinned = next;
    return next;
  }

  removeMatching(projectPath: string): boolean {
    const prefix = projectPath + '/';
    const before = this.pinned.length;
    this.pinned = this.pinned.filter((p) => p !== projectPath && !p.startsWith(prefix));
    return this.pinned.length !== before;
  }
}
