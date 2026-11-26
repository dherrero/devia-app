import type { GitRunner } from '../infrastructure/git-runner';

export interface IntegrateWorkerInput {
  /** Checkout the controller works in (its pane worktree or the base project). */
  controllerCwd: string;
  /** The worker's branch. */
  branch: string;
  worktreeDir: string;
  /** The base project checkout (where `git worktree` commands are valid). */
  baseProject: string;
}

export type IntegrationFailure = 'not_ff' | 'dirty' | 'git_error';

export type IntegrationResult =
  | { ok: true; commits: string[] }
  | { ok: false; reason: IntegrationFailure; detail: string };

/**
 * Brings a worker's commits into the controller's branch with `merge --ff-only`
 * (S-56). It never forces: if the controller moved on, or its uncommitted edits
 * would be overwritten, nothing changes and the reason comes back for the
 * controller to resolve. On success the worker's worktree and merged branch are
 * removed; on failure both are kept, because they hold the only copy of the work.
 */
export async function integrateWorker(
  deps: { git: GitRunner },
  input: IntegrateWorkerInput,
): Promise<IntegrationResult> {
  const { git } = deps;
  const { controllerCwd, branch } = input;

  const exists = git.run(controllerCwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
  if (!exists.ok) return { ok: false, reason: 'git_error', detail: `Branch ${branch} does not exist.` };

  const log = git.run(controllerCwd, ['log', '--reverse', '--format=%h', `HEAD..${branch}`]);
  if (!log.ok) return { ok: false, reason: 'git_error', detail: log.stderr || 'git log failed.' };
  const commits = log.stdout.split('\n').filter((line) => line.length > 0);

  if (commits.length > 0) {
    const merge = git.run(controllerCwd, ['merge', '--ff-only', branch]);
    if (!merge.ok) {
      const message = `${merge.stderr}\n${merge.stdout}`;
      if (/not possible to fast-forward|diverg|refusing to merge/i.test(message)) {
        return {
          ok: false,
          reason: 'not_ff',
          detail: `The controller branch moved on since the worker started, so ${branch} cannot fast-forward into it. The work is intact on ${branch}.`,
        };
      }
      if (/would be overwritten|local changes|untracked working tree/i.test(message)) {
        return {
          ok: false,
          reason: 'dirty',
          detail: `Uncommitted changes in the controller checkout would be overwritten by ${branch}. Commit or stash them first. The work is intact on ${branch}.`,
        };
      }
      return { ok: false, reason: 'git_error', detail: merge.stderr || 'git merge failed.' };
    }
  }

  // Merged (or nothing to merge): the worktree and the branch are no longer needed.
  // Best-effort: a failed cleanup must never undo or hide a successful integration.
  git.run(input.baseProject, ['worktree', 'remove', '--force', input.worktreeDir]);
  git.run(controllerCwd, ['branch', '-d', branch]);
  return { ok: true, commits };
}
