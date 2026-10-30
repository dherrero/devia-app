import * as path from 'node:path';
import * as fs from 'node:fs';
import type { GitExecFn } from './cli-git-worktree-manager';
import { execFileSyncOnPath } from '../../cli-adapters/infrastructure/path-command';
import type { WorktreeRef } from '../domain/worktree-ref';

// ---------------------------------------------------------------------------
// Injectable seams (defaulting to real fs + exec so the main path needs no args)
// ---------------------------------------------------------------------------

export interface FsOps {
  existsSync(p: string): boolean;
  readdirSync(p: string): string[];
  rmSync(p: string, options: { recursive: boolean; force: boolean }): void;
}

function defaultExec(
  command: string,
  args: readonly string[],
  options: Parameters<GitExecFn>[2],
): Buffer {
  return execFileSyncOnPath(command, args, options) as Buffer;
}

const defaultFs: FsOps = {
  existsSync: (p) => fs.existsSync(p),
  readdirSync: (p) => fs.readdirSync(p) as string[],
  rmSync: (p, opts) => fs.rmSync(p, opts),
};

// ---------------------------------------------------------------------------
// cleanupSession
// ---------------------------------------------------------------------------

export interface CleanupSessionResult {
  removed: boolean;
  branchDeleted: boolean;
}

/**
 * Removes one session's worktree (force) + prunes git admin refs, then
 * force-deletes the session branch.
 *
 * Both steps are best-effort: a failure in either is swallowed so callers
 * (T-143 panel-close flow) are never blocked. The return value records what
 * actually happened.
 *
 * Branch deletion is force (`-D`) because the session branch is an ephemeral
 * scratch branch. The merge-or-discard UX that decides whether to integrate
 * the work before deleting lives in T-143; this primitive is called only after
 * that decision has been made (or when sweeping orphans where no merge is
 * possible).
 */
export function cleanupSession(
  ref: WorktreeRef,
  exec: GitExecFn = defaultExec,
): CleanupSessionResult {
  let removed = false;
  let branchDeleted = false;

  try {
    exec('git', ['worktree', 'remove', '--force', ref.worktreeDir], {
      cwd: ref.baseProject,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    removed = true;
  } catch {
    // best-effort — directory may already be gone
  }

  try {
    exec('git', ['worktree', 'prune'], {
      cwd: ref.baseProject,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    // prune failures are non-fatal
  }

  try {
    exec('git', ['branch', '-D', ref.branch], {
      cwd: ref.baseProject,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    branchDeleted = true;
  } catch {
    // Branch may not exist (already merged/deleted), have unmerged commits, or
    // the repo may be in a detached state — none of these should fail cleanup.
  }

  return { removed, branchDeleted };
}

// ---------------------------------------------------------------------------
// sweepOrphans
// ---------------------------------------------------------------------------

export interface SweepOrphansResult {
  swept: string[];
}

/**
 * Removes worktree directories under `<deviaDir>/worktrees/` that are not
 * in `liveWorktreeDirs`.
 *
 * At cold startup `liveWorktreeDirs` is empty (no session has been restored
 * yet), so every leftover directory is treated as an orphan from a previous
 * crash/clean-close. T-143's layout persistence will later pass the set of
 * restored session dirs so that revived sessions are preserved.
 *
 * Runs regardless of the `worktreePerSession` flag: if the flag was previously
 * on and the user turned it off, the worktrees root may still contain
 * directories that need to be cleaned up on the next startup.
 *
 * For each orphan directory the strategy is:
 *   1. Try `git -C <worktreeDir> rev-parse --git-common-dir` to find the base
 *      repo. If successful, run `worktree remove --force` + `worktree prune`
 *      from the base so git's admin refs are cleaned up properly.
 *   2. If step 1 fails (broken / not a worktree), fall back to a plain
 *      `fs.rmSync` to reclaim the disk space without touching git.
 */
export function sweepOrphans(
  deviaDir: string,
  liveWorktreeDirs: ReadonlySet<string> = new Set(),
  exec: GitExecFn = defaultExec,
  fsOps: FsOps = defaultFs,
): SweepOrphansResult {
  const root = path.join(deviaDir, 'worktrees');
  if (!fsOps.existsSync(root)) return { swept: [] };

  const swept: string[] = [];

  let projectKeys: string[];
  try {
    projectKeys = fsOps.readdirSync(root);
  } catch {
    return { swept: [] };
  }

  for (const key of projectKeys) {
    const keyDir = path.join(root, key);
    let sessionIds: string[];
    try {
      sessionIds = fsOps.readdirSync(keyDir);
    } catch {
      continue;
    }

    for (const sid of sessionIds) {
      const worktreeDir = path.join(keyDir, sid);

      // A live session's worktree must not be touched.
      if (liveWorktreeDirs.has(worktreeDir)) continue;

      let cleanedViaGit = false;
      try {
        // Resolve the base repo path from inside the worktree.
        const commonDirBuf = exec(
          'git',
          ['-C', worktreeDir, 'rev-parse', '--git-common-dir'],
          { cwd: worktreeDir, stdio: ['ignore', 'pipe', 'pipe'] },
        );
        // --git-common-dir returns the path to <base>/.git (or a relative path
        // inside the worktree's own .git file — resolve against the worktree dir
        // to get an absolute path, then walk up one level to the base repo).
        const commonDirRaw = commonDirBuf.toString().trim();
        const commonDirAbs = path.isAbsolute(commonDirRaw)
          ? commonDirRaw
          : path.resolve(worktreeDir, commonDirRaw);
        // commonDirAbs is the .git directory of the base repo.
        const baseProject = path.dirname(commonDirAbs);

        exec('git', ['worktree', 'remove', '--force', worktreeDir], {
          cwd: baseProject,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        try {
          exec('git', ['worktree', 'prune'], {
            cwd: baseProject,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
        } catch {
          // prune failure after a successful remove is non-fatal
        }
        cleanedViaGit = true;
      } catch {
        // rev-parse or worktree remove failed — directory is broken/not a worktree
      }

      if (!cleanedViaGit) {
        try {
          fsOps.rmSync(worktreeDir, { recursive: true, force: true });
        } catch {
          // last-resort rm also failed; skip and move on
          continue;
        }
      }

      swept.push(worktreeDir);
    }
  }

  return { swept };
}
