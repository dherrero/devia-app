import type { OutboxFile } from '../../../shared/domain/attachment';

/** A file found in the outbox, BEFORE it is moved to the archive. */
export interface OutboxEntry {
  /** Absolute path inside `<projectPath>/outbox/` (still inside the workspace roots). */
  path: string;
  name: string;
}

export interface FlushedOutboxFile<T> {
  file: OutboxFile;
  /**
   * What `check` returned for the entry's ORIGINAL path. Absent when no check
   * was passed, or when the entry is not a regular file (a symlink is archived
   * but never offered: its archived copy would still point at the target).
   */
  verdict?: T;
}

/**
 * Owned by the `outbox` feature. The claude-runner calls `flush(cwd)` when a
 * run ends so any file the agent dropped under `<cwd>/outbox/` is archived
 * and reported back to the renderer (and, S-32, to the remote chat).
 */
export interface OutboxFlusher {
  /**
   * `projectPath` is the run's ABSOLUTE effective cwd (the session worktree in
   * an isolated pane). `check` runs on each regular file before it is moved.
   */
  flush<T = never>(projectPath: string, check?: (entry: OutboxEntry) => T): FlushedOutboxFile<T>[];
}
