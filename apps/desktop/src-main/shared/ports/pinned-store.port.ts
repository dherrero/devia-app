/**
 * Ordered list of project paths the user has pinned to the sidebar's
 * "Fijados" section. Owned by the `pinned-projects` feature; consumed by
 * persistence (snapshotting state.json) and workspace (drop dangling pins
 * after a trash cascade).
 */
export interface PinnedStore {
  list(): string[];
  /** Replaces the list atomically. Returns the canonicalised list. */
  set(paths: string[]): string[];
  /** Drops any pin equal to `projectPath` or descended from it. Used by the
   *  trash-project use case. Returns true if anything changed. */
  removeMatching(projectPath: string): boolean;
}
