import type { GitInfo, DiffResult } from '../../../shared/domain/git';

/**
 * Read-side surface of the `git` feature. Other features (status, gitWatcher)
 * consume it without touching git internals.
 */
export interface GitInspector {
  info(projectPath: string): GitInfo | null;
  diff(projectPath: string): DiffResult;
  /**
   * Non-blocking async variant of `diff`. Uses `execFile` internally so it
   * never blocks the V8 event loop. Preferred for hot paths such as the
   * post-file-edit diff snapshot in `sendDiffSnapshot` (TS-CLI-10,
   * REV-TS-CLI-10-02). Returns `{ hasChanges: false, files: [] }` on any
   * error (git not installed, not a repo, etc.) to keep callers simple.
   */
  asyncDiff(projectPath: string): Promise<DiffResult>;
  /**
   * Resolves the repository's default branch with a remote-query fallback for
   * repos that don't have `refs/remotes/origin/HEAD` set locally (typical of
   * `git init` + `git remote add` flows, where no clone ever ran). Result is
   * cached per project so subsequent `info()` calls see a populated
   * `defaultBranch`. Network-touching, so callers should treat it as a one-shot
   * warmup, not something to invoke from a hot path.
   */
  warmDefaultBranch(projectPath: string): Promise<string | null>;
}
