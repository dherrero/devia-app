import type { FeatureContext } from '../../../shared/feature';
import { IPC } from '../../../../shared/contracts/ipc-channels';
import type { ConfigRepository, GitInspector } from '../../../shared/ports';
import { resolveInsideWorkspace } from '../../../shared/workspace-paths';
import type { GitBrancher, GitSyncer, GitWatcher, GitWorktreeManager, WorktreeError } from '../domain/ports';
import { worktreeRefFor } from '../domain/worktree-ref';
import type { WorktreeListItem, WorktreeView } from '../../../../shared/domain/worktree';
import type { BranchCheckoutRef } from '../../../../shared/domain/git';

export interface GitIpcDeps {
  inspector: GitInspector;
  watcher: GitWatcher;
  syncer: GitSyncer;
  brancher: GitBrancher;
  worktreeManager: GitWorktreeManager;
  config: ConfigRepository;
  /** S-3 F1.2: ref a session worktree's branch is created from. */
  baseRefFor: (repoAbs: string) => string;
  /** S-3: full teardown (worktree + session branch), best-effort. */
  cleanup: (baseProject: string, sessionId: string) => unknown;
}

export function registerGitIpc(ctx: FeatureContext, deps: GitIpcDeps): void {
  ctx.ipc.handle(IPC.gitInfo, (_e, projectPath: string) => deps.inspector.info(projectPath));

  ctx.ipc.handle(IPC.gitWatch, (_e, projectPath: string | null) => {
    if (!projectPath) {
      deps.watcher.stop();
      return true;
    }
    deps.watcher.start(projectPath, (payload) => ctx.send('git:info-changed', payload));
    // Resolve the default branch in the background (local → remote fallback)
    // and kick the watcher so info() picks up the freshly cached value. This
    // is what surfaces the footer sync button on repos that don't have
    // `origin/HEAD` set locally.
    void deps.inspector.warmDefaultBranch(projectPath).then(() => deps.watcher.refresh());
    return true;
  });

  ctx.ipc.handle(IPC.gitDiff, (_e, projectPath: string) => deps.inspector.diff(projectPath));

  ctx.ipc.handle(IPC.gitSync, async (_e, projectPath: string) => {
    const result = await deps.syncer.sync(projectPath);
    // Branch + dirty state changed under us. Kick the watcher so the footer
    // updates immediately instead of waiting on the next fs.watch debounce.
    if (result.ok) deps.watcher.refresh();
    return result;
  });

  ctx.ipc.handle(IPC.gitPull, async (_e, projectPath: string) => {
    const result = await deps.syncer.pull(projectPath);
    if (result.ok) deps.watcher.refresh();
    return result;
  });

  ctx.ipc.handle(IPC.gitListBranches, (_e, projectPath: string) => deps.brancher.list(projectPath));

  ctx.ipc.handle(IPC.gitCheckout, async (_e, projectPath: string, ref: BranchCheckoutRef) => {
    const result = await deps.brancher.checkout(projectPath, ref);
    // HEAD + working tree changed; kick the watcher so the footer updates
    // immediately instead of waiting on the fs.watch debounce (same as gitSync).
    if (result.ok) deps.watcher.refresh();
    return result;
  });

  // The renderer identifies projects by their workspace-RELATIVE key
  // (ProjectEntry.path). Worktree git commands run with cwd = baseProject and
  // derive the worktree projectKey from it, so the key MUST be resolved to the
  // absolute checkout here — the runner builds its ref from the resolved cwd
  // (run-instruction), and both sides must land on the same worktree dir.
  ctx.ipc.handle(IPC.gitWorktreeAdd, async (_e, baseProject: string, sessionId: string): Promise<WorktreeView> => {
    const base = resolveInsideWorkspace(deps.config, baseProject).abs;
    const ref = worktreeRefFor(deps.config.deviaDir(), base, sessionId);
    try {
      await deps.worktreeManager.add(ref, deps.baseRefFor(base));
    } catch (err) {
      // Surface the typed code to the renderer; keep host-path detail in logs only.
      const we = err as WorktreeError;
      if (we?.name === 'WorktreeError') {
        console.error(`[git:worktree-add] ${we.code}: ${we.detail}`);
        throw new Error(`worktree-add failed: ${we.code}`);
      }
      throw err;
    }
    return { sessionId: ref.sessionId, worktreeDir: ref.worktreeDir, branch: ref.branch };
  });

  ctx.ipc.handle(IPC.gitWorktreeRemove, async (_e, baseProject: string, sessionId: string): Promise<void> => {
    const ref = worktreeRefFor(deps.config.deviaDir(), resolveInsideWorkspace(deps.config, baseProject).abs, sessionId);
    try {
      await deps.worktreeManager.remove(ref);
    } catch (err) {
      const we = err as WorktreeError;
      if (we?.name === 'WorktreeError') {
        console.error(`[git:worktree-remove] ${we.code}: ${we.detail}`);
        throw new Error(`worktree-remove failed: ${we.code}`);
      }
      throw err;
    }
  });

  // Pane closed with ZERO activity (S-3): tear down worktree AND session
  // branch — nothing was ever produced on it. A pane with activity goes
  // through gitWorktreeRemove instead, so the branch survives for the F2.2
  // recovery chain.
  ctx.ipc.handle(IPC.gitWorktreeCleanup, async (_e, baseProject: string, sessionId: string): Promise<void> => {
    deps.cleanup(baseProject, sessionId);
  });

  ctx.ipc.handle(IPC.gitWorktreeList, async (_e, baseProject: string): Promise<WorktreeListItem[]> => {
    const items = await deps.worktreeManager.list(resolveInsideWorkspace(deps.config, baseProject).abs);
    return items.map((info): WorktreeListItem => {
      const item: WorktreeListItem = { worktreeDir: info.worktreeDir };
      if (info.branch !== undefined) item.branch = info.branch;
      if (info.head !== undefined) item.head = info.head;
      return item;
    });
  });
}
