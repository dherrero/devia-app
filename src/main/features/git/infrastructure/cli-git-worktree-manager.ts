import type { ExecFileSyncOptions } from 'node:child_process';
import { execFileSyncOnPath } from '../../cli-adapters/infrastructure/path-command';
import type { GitWorktreeManager, WorktreeInfo, WorktreeErrorCode } from '../domain/ports';
import { WorktreeError } from '../domain/ports';
import type { WorktreeRef } from '../domain/worktree-ref';

// ---------------------------------------------------------------------------
// Injectable exec seam
// ---------------------------------------------------------------------------

/**
 * Subset of execFileSyncOnPath's signature used by CliGitWorktreeManager.
 * Injected as a constructor parameter so tests can assert exact argv without
 * spawning a real git process (AGENTS.md: no real CLI in unit tests).
 */
export type GitExecFn = (
  command: string,
  args: readonly string[],
  options: ExecFileSyncOptions,
) => Buffer;

function defaultExec(
  command: string,
  args: readonly string[],
  options: ExecFileSyncOptions,
): Buffer {
  return execFileSyncOnPath(command, args, options) as Buffer;
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

const NOT_A_REPO_RE = /not a git repository/i;
const NO_COMMITS_RE =
  /does not have any commits yet|invalid reference:\s*HEAD|ambiguous argument 'HEAD'/i;
const BRANCH_EXISTS_RE = /branch.*already exists|a branch named .* already exists/i;
const WORKTREE_EXISTS_RE = /already (checked out|exists)/i;

function classifyGitError(raw: string): WorktreeError {
  if (NOT_A_REPO_RE.test(raw)) return new WorktreeError('not-a-repo', raw);
  if (NO_COMMITS_RE.test(raw)) return new WorktreeError('no-commits', raw);
  if (BRANCH_EXISTS_RE.test(raw)) return new WorktreeError('branch-exists', raw);
  if (WORKTREE_EXISTS_RE.test(raw)) return new WorktreeError('worktree-exists', raw);
  return new WorktreeError('unknown', raw);
}

function toText(value: Buffer | string | undefined): string {
  if (value === undefined) return '';
  return typeof value === 'string' ? value : value.toString();
}

function extractRawMessage(err: unknown): string {
  if (err instanceof Error) {
    const e = err as Error & { stderr?: Buffer | string; stdout?: Buffer | string };
    return (toText(e.stderr) || toText(e.stdout) || e.message).trim();
  }
  return String(err);
}

// ---------------------------------------------------------------------------
// Synchronous private cores — shared by the async port and ensureWorktreeSync
// ---------------------------------------------------------------------------

function addSync(exec: GitExecFn, ref: WorktreeRef, baseRef = 'HEAD'): void {
  exec(
    'git',
    ['worktree', 'add', '-b', ref.branch, ref.worktreeDir, baseRef],
    { cwd: ref.baseProject, stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

function listSync(exec: GitExecFn, baseProject: string): WorktreeInfo[] {
  const raw = exec(
    'git',
    ['worktree', 'list', '--porcelain'],
    { cwd: baseProject, stdio: ['ignore', 'pipe', 'pipe'] },
  ).toString();
  return parsePorcelainWorktreeList(raw);
}

// ---------------------------------------------------------------------------
// ensureWorktreeSync — synchronous best-effort worktree guarantee (T-153)
// ---------------------------------------------------------------------------

export type EnsureWorktreeResult =
  | { ok: true; created: boolean }
  | { ok: false; code: WorktreeErrorCode };

/**
 * Ensures a worktree for `ref` exists, creating it when absent.
 * Synchronous so it can be called from the synchronous execute() path.
 *
 * branch-exists / worktree-exists are treated as "already there" when the
 * worktreeDir is reachable, so a restarted session never hard-fails.
 */
export function ensureWorktreeSync(
  ref: WorktreeRef,
  exec: GitExecFn = defaultExec,
  /** S-3 F1.2: ref the session branch is created FROM. 'HEAD' preserves the
   *  pre-S-3 behaviour; the composition root passes the repo's default branch
   *  so a session never inherits the primary pane's in-flight commits. */
  baseRef = 'HEAD',
): EnsureWorktreeResult {
  // List first; if the dir is already registered we skip the add entirely.
  let existing: WorktreeInfo[];
  try {
    existing = listSync(exec, ref.baseProject);
  } catch (err) {
    const we = err instanceof WorktreeError ? err : classifyGitError(extractRawMessage(err));
    return { ok: false, code: we.code };
  }

  if (existing.some((w) => w.worktreeDir === ref.worktreeDir)) {
    return { ok: true, created: false };
  }

  try {
    // node_modules are intentionally not created/symlinked/copied — agents
    // reinstall only if needed. See docs/multisesion/02-worktree-lifecycle.md.
    addSync(exec, ref, baseRef);
    return { ok: true, created: true };
  } catch (err) {
    const we = err instanceof WorktreeError ? err : classifyGitError(extractRawMessage(err));
    // A pre-existing branch or worktree at the same path means git already
    // has the directory registered under a different name; treat it as present.
    if (we.code === 'branch-exists' || we.code === 'worktree-exists') {
      return { ok: true, created: false };
    }
    return { ok: false, code: we.code };
  }
}

// ---------------------------------------------------------------------------
// reattachWorktreeSync — S-3 F2.2 recovery: worktree swept, branch survived
// ---------------------------------------------------------------------------

/**
 * Re-create the worktree directory for a session whose branch still exists
 * (`git worktree add <dir> <branch>`, NO `-b` — the branch carries the
 * session's commits; resetting it would lose them). Returns false when the
 * branch is gone or git refuses; the caller falls back to the base checkout.
 */
export function reattachWorktreeSync(ref: WorktreeRef, exec: GitExecFn = defaultExec): boolean {
  try {
    exec(
      'git',
      ['rev-parse', '--verify', '--quiet', `refs/heads/${ref.branch}`],
      { cwd: ref.baseProject, stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch {
    return false;
  }
  try {
    exec(
      'git',
      ['worktree', 'add', ref.worktreeDir, ref.branch],
      { cwd: ref.baseProject, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return true;
  } catch (err) {
    const we = err instanceof WorktreeError ? err : classifyGitError(extractRawMessage(err));
    // Already registered at that path → treat as reattached.
    return we.code === 'worktree-exists';
  }
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class CliGitWorktreeManager implements GitWorktreeManager {
  private readonly exec: GitExecFn;

  constructor(exec: GitExecFn = defaultExec) {
    this.exec = exec;
  }

  async add(ref: WorktreeRef, baseRef = 'HEAD'): Promise<void> {
    try {
      addSync(this.exec, ref, baseRef);
    } catch (err) {
      throw classifyGitError(extractRawMessage(err));
    }
  }

  async remove(ref: WorktreeRef): Promise<void> {
    let removeError: WorktreeError | undefined;
    try {
      this.exec(
        'git',
        ['worktree', 'remove', '--force', ref.worktreeDir],
        { cwd: ref.baseProject, stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch (err) {
      removeError = classifyGitError(extractRawMessage(err));
    }

    // Prune stale administrative files even when remove failed — the worktree
    // directory may have been deleted manually while git still tracks it, so
    // prune is the correct way to reclaim those refs.
    try {
      this.exec(
        'git',
        ['worktree', 'prune'],
        { cwd: ref.baseProject, stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch {
      // prune failures are non-fatal.
    }

    if (removeError !== undefined) throw removeError;
  }

  async list(baseProject: string): Promise<WorktreeInfo[]> {
    try {
      return listSync(this.exec, baseProject);
    } catch (err) {
      throw classifyGitError(extractRawMessage(err));
    }
  }
}

// ---------------------------------------------------------------------------
// Porcelain parser
// ---------------------------------------------------------------------------

/**
 * Parses `git worktree list --porcelain` output into WorktreeInfo records.
 *
 * Each worktree record is a blank-line-delimited block of key-value lines:
 *   worktree <path>
 *   HEAD <sha>           (absent for bare)
 *   branch refs/heads/<name>  |  detached  |  bare
 *
 * Exported for unit-test coverage without instantiating the manager.
 */
export function parsePorcelainWorktreeList(raw: string): WorktreeInfo[] {
  const results: WorktreeInfo[] = [];
  // Split on one or more blank lines to get per-worktree blocks.
  const blocks = raw.split(/\n\n+/);
  for (const block of blocks) {
    const lines = block.trim().split('\n');
    if (!lines[0]) continue;

    let worktreeDir: string | undefined;
    let head: string | undefined;
    let branch: string | undefined;

    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        worktreeDir = line.slice('worktree '.length).trim();
      } else if (line.startsWith('HEAD ')) {
        head = line.slice('HEAD '.length).trim();
      } else if (line.startsWith('branch ')) {
        const ref = line.slice('branch '.length).trim();
        // Strip the refs/heads/ prefix to keep only the short branch name.
        branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
      }
      // `detached` and `bare` lines are intentionally ignored:
      // they have no additional value beyond the absence of `branch`.
    }

    if (!worktreeDir) continue;

    const info: WorktreeInfo = { worktreeDir };
    if (branch !== undefined) info.branch = branch;
    if (head !== undefined) info.head = head;
    results.push(info);
  }
  return results;
}
