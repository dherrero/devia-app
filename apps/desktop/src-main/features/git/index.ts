import type { Feature, FeatureContext } from '../../shared/feature';
import type { ConfigRepository, GitInspector } from '../../shared/ports';

import * as fs from 'node:fs';
import * as path from 'node:path';

import { CliGitInspector } from './infrastructure/cli-git-inspector';
import { CliGitSyncer } from './infrastructure/cli-git-syncer';
import { CliGitBrancher } from './infrastructure/cli-git-brancher';
import { CliGitWorktreeManager, ensureWorktreeSync, reattachWorktreeSync } from './infrastructure/cli-git-worktree-manager';
import { worktreeRefFor } from './domain/worktree-ref';
import { isPathContained, resolveInsideWorkspace } from '../../shared/workspace-paths';
import type { EnsureWorktreeResult } from './infrastructure/cli-git-worktree-manager';
import { FsGitWatcher } from './infrastructure/fs-git-watcher';
import { cleanupSession, sweepOrphans } from './infrastructure/worktree-lifecycle';
import type { CleanupSessionResult } from './infrastructure/worktree-lifecycle';
import { registerGitIpc } from './ipc/git.ipc';
import type { GitBrancher, GitSyncer, GitWatcher, GitWorktreeManager } from './domain/ports';
import type { WorktreeRef } from './domain/worktree-ref';

export { CliGitInspector } from './infrastructure/cli-git-inspector';
export { CliGitWorktreeManager } from './infrastructure/cli-git-worktree-manager';
export type { EnsureWorktreeResult } from './infrastructure/cli-git-worktree-manager';

export interface GitDeps {
  config: ConfigRepository;
}

export interface GitExports {
  inspector: GitInspector;
  watcher: GitWatcher;
  syncer: GitSyncer;
  brancher: GitBrancher;
  worktreeManager: GitWorktreeManager;
  /** Synchronous worktree guarantee consumed by the claude-runner (T-153). */
  ensureSessionWorktree: (ref: WorktreeRef) => EnsureWorktreeResult;
  /**
   * Removes a session's worktree + session BRANCH (best-effort, never throws).
   * Two consumers (S-3 lifecycle): the gitWorktreeCleanup IPC (pane closed
   * with zero activity) and DeleteSessionUseCase (explicit, confirmed session
   * delete). `branch` overrides the sessionId-derived name when the persisted
   * session carries the authoritative one. `baseProject` may be the renderer's
   * workspace-relative key. Returns null when the key cannot be resolved.
   */
  cleanupSessionWorktree: (baseProject: string, sessionId: string, branch?: string) => CleanupSessionResult | null;
  /**
   * S-3 F2.2 recovery chain. `isLiveSessionWorktree` validates a persisted
   * workdir before reattaching (exists + inside the managed worktrees root —
   * a tampered session file must never point a run at an arbitrary path).
   * `reattachSessionWorktree` recreates the worktree from its surviving
   * branch; returns the workdir or null.
   */
  isLiveSessionWorktree: (workdir: string) => boolean;
  reattachSessionWorktree: (baseProject: string, sessionId: string, branch: string) => string | null;
}

export interface BuiltGitFeature {
  feature: Feature;
  exports: GitExports;
}

export function buildGitFeature(deps: GitDeps): BuiltGitFeature {
  const inspector = new CliGitInspector(deps.config);
  const watcher = new FsGitWatcher(deps.config, inspector);
  const syncer = new CliGitSyncer(deps.config);
  const brancher = new CliGitBrancher(deps.config);
  const worktreeManager = new CliGitWorktreeManager();

  // S-3 F1.2: ref every session branch is created FROM. Default-branch keeps
  // session Z clean of the primary pane's in-flight commits; falls back to
  // HEAD only when the default branch cannot be resolved (no remote, no refs).
  const baseRefFor = (repo: string): string => {
    if ((deps.config.get().worktreeBaseRef ?? 'default-branch') === 'current') return 'HEAD';
    const branch = inspector.defaultBranchSync(repo);
    if (!branch) {
      console.log(`[git:worktree] default branch unresolved for "${repo}" — branching session off HEAD`);
      return 'HEAD';
    }
    return branch;
  };

  // Renderer-supplied project ids are workspace-relative keys (ProjectEntry
  // .path); worktree refs need the absolute checkout (exec cwd + projectKey).
  const resolveBase = (baseProject: string): string | null => {
    try {
      return resolveInsideWorkspace(deps.config, baseProject).abs;
    } catch {
      return null;
    }
  };

  const cleanupByKey = (
    baseProject: string,
    sessionId: string,
    branch?: string,
  ): CleanupSessionResult | null => {
    const base = resolveBase(baseProject);
    if (base === null) return null;
    const ref = worktreeRefFor(deps.config.deviaDir(), base, sessionId);
    return cleanupSession(branch !== undefined ? { ...ref, branch } : ref);
  };

  const feature: Feature = {
    id: 'git',
    register(ctx: FeatureContext) {
      registerGitIpc(ctx, {
        inspector,
        watcher,
        syncer,
        brancher,
        worktreeManager,
        config: deps.config,
        baseRefFor,
        cleanup: cleanupByKey,
      });
    },
    onReady(ctx: FeatureContext) {
      // Safety net for changes made outside Devia (terminal, remote merge
      // + pull). fs.watch should catch them already, but a focus-driven
      // refresh covers edge cases where the OS coalesces away the FS event.
      const win = ctx.getMainWindow();
      if (win) win.on('focus', () => watcher.refresh());

      // Purge worktree directories left over from a previous run (crash /
      // clean-close before panel teardown). Runs regardless of the
      // worktreePerSession flag so a user who turns the flag off still gets
      // the leftover dirs from when it was on cleaned up automatically.
      // Empty live-set is correct here: no session has been restored yet at
      // onReady time. T-143 will pass the restored session dirs later.
      try {
        const { swept } = sweepOrphans(deps.config.deviaDir());
        if (swept.length > 0) {
          console.log(`[git:sweep] removed ${swept.length} orphan worktree(s)`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[git:sweep] startup sweep failed:', msg);
      }
    },
    onBeforeQuit() {
      watcher.stop();
    },
  };

  return {
    feature,
    exports: {
      inspector,
      watcher,
      syncer,
      brancher,
      worktreeManager,
      ensureSessionWorktree: (ref) => ensureWorktreeSync(ref, undefined, baseRefFor(ref.baseProject)),
      cleanupSessionWorktree: cleanupByKey,
      isLiveSessionWorktree: (workdir) => {
        const root = path.join(deps.config.deviaDir(), 'worktrees');
        // Worktree dirs carry a `.git` FILE pointing at the base repo.
        return isPathContained(workdir, root) && fs.existsSync(path.join(workdir, '.git'));
      },
      reattachSessionWorktree: (baseProject, sessionId, branch) => {
        const base = resolveBase(baseProject);
        if (base === null) return null; // best-effort — fall back to the base checkout
        const ref = worktreeRefFor(deps.config.deviaDir(), base, sessionId);
        // The persisted branch is authoritative — a sessionId-derived default
        // could drift if naming ever changes.
        const target = { ...ref, branch };
        return reattachWorktreeSync(target) ? target.worktreeDir : null;
      },
    },
  };
}
