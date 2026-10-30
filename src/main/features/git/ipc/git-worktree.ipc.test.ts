import { describe, it, expect, vi } from 'vitest';
import { registerGitIpc } from './git.ipc';
import type { GitIpcDeps } from './git.ipc';
import type { FeatureContext } from '../../../shared/feature';
import { IPC } from '../../../../shared/contracts/ipc-channels';
import { WorktreeError } from '../domain/ports';
import type { WorktreeInfo } from '../domain/ports';
import type { WorktreeRef } from '../domain/worktree-ref';

type Handler = (event: unknown, ...args: unknown[]) => unknown;

function captureHandlers(): { ctx: FeatureContext; handlers: Map<string, Handler> } {
  const handlers = new Map<string, Handler>();
  const ctx = {
    ipc: { handle: (channel: string, fn: Handler) => handlers.set(channel, fn) },
    send: () => undefined,
    getMainWindow: () => null,
  } as unknown as FeatureContext;
  return { ctx, handlers };
}

const DEVIA = '/home/u/.devia-app';
const SID = 'a1b2c3d4-e5f6-7890-abcd-ef0123456789';
const WSROOT = '/home/u/repos';
const BASE = '/home/u/repos/myApp';

function deps(overrides: Partial<GitIpcDeps['worktreeManager']> = {}): {
  d: GitIpcDeps;
  added: WorktreeRef[];
  removed: WorktreeRef[];
} {
  const added: WorktreeRef[] = [];
  const removed: WorktreeRef[] = [];
  const worktreeManager: GitIpcDeps['worktreeManager'] = {
    add: vi.fn(async (ref: WorktreeRef) => {
      added.push(ref);
    }),
    remove: vi.fn(async (ref: WorktreeRef) => {
      removed.push(ref);
    }),
    list: vi.fn(async (): Promise<WorktreeInfo[]> => []),
    ...overrides,
  };
  const d = {
    inspector: {} as GitIpcDeps['inspector'],
    watcher: {} as GitIpcDeps['watcher'],
    syncer: {} as GitIpcDeps['syncer'],
    brancher: {} as GitIpcDeps['brancher'],
    worktreeManager,
    config: {
      deviaDir: () => DEVIA,
      get: () => ({ workspaceRoot: WSROOT }),
    } as unknown as GitIpcDeps['config'],
    baseRefFor: vi.fn(() => 'main'),
    cleanup: vi.fn(),
  } as GitIpcDeps;
  return { d, added, removed };
}

describe('git worktree IPC handlers', () => {
  it('add builds the ref from worktreeRefFor and returns a serialisable view', async () => {
    const { d, added } = deps();
    const { ctx, handlers } = captureHandlers();
    registerGitIpc(ctx, d);

    const view = await handlers.get(IPC.gitWorktreeAdd)!(null, BASE, SID);

    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ baseProject: BASE, sessionId: SID });
    expect(added[0]!.worktreeDir).toContain('worktrees');
    expect(view).toEqual({
      sessionId: SID,
      worktreeDir: added[0]!.worktreeDir,
      branch: added[0]!.branch,
    });
  });

  it('add resolves a workspace-relative project key to the absolute checkout', async () => {
    // ProjectEntry.path (the renderer's project id) is RELATIVE to
    // workspaceRoot. Passing it through unresolved made every `git worktree
    // add` spawn with a non-existent cwd (ENOENT), so isolation always failed.
    const { d, added } = deps();
    const { ctx, handlers } = captureHandlers();
    registerGitIpc(ctx, d);

    await handlers.get(IPC.gitWorktreeAdd)!(null, 'myApp', SID);

    expect(added).toHaveLength(1);
    expect(added[0]!.baseProject).toBe(BASE);
    // The worktree dir key must derive from the ABSOLUTE path — same key the
    // runner derives from its resolved cwd, or the two sides would create two
    // different worktrees for one session.
    expect(added[0]!.worktreeDir).toBe(`${DEVIA}/worktrees/home-u-repos-myApp/${SID}`);
    expect(d.baseRefFor).toHaveBeenCalledWith(BASE);
  });

  it('add rejects a project key escaping the workspace', async () => {
    const { d, added } = deps();
    const { ctx, handlers } = captureHandlers();
    registerGitIpc(ctx, d);

    await expect(handlers.get(IPC.gitWorktreeAdd)!(null, '../outside', SID)).rejects.toThrow();
    expect(added).toHaveLength(0);
  });

  it('remove resolves a workspace-relative project key to the same ref as add', async () => {
    const { d, added, removed } = deps();
    const { ctx, handlers } = captureHandlers();
    registerGitIpc(ctx, d);

    await handlers.get(IPC.gitWorktreeAdd)!(null, 'myApp', SID);
    await handlers.get(IPC.gitWorktreeRemove)!(null, 'myApp', SID);

    expect(removed).toHaveLength(1);
    expect(removed[0]).toEqual(added[0]);
  });

  it('cleanup (zero-activity pane close) delegates to the full teardown', async () => {
    const { d } = deps();
    const { ctx, handlers } = captureHandlers();
    registerGitIpc(ctx, d);

    await handlers.get(IPC.gitWorktreeCleanup)!(null, 'myApp', SID);

    expect(d.cleanup).toHaveBeenCalledWith('myApp', SID);
  });

  it('list resolves a workspace-relative project key before delegating', async () => {
    const { d } = deps();
    const { ctx, handlers } = captureHandlers();
    registerGitIpc(ctx, d);

    await handlers.get(IPC.gitWorktreeList)!(null, 'myApp');

    expect(d.worktreeManager.list).toHaveBeenCalledWith(BASE);
  });

  it('add maps a WorktreeError to a code-only message (no host path leak)', async () => {
    const { d } = deps({
      add: vi.fn(async () => {
        throw new WorktreeError('branch-exists', `fatal at ${DEVIA}/secret`);
      }),
    });
    const { ctx, handlers } = captureHandlers();
    registerGitIpc(ctx, d);

    await expect(handlers.get(IPC.gitWorktreeAdd)!(null, BASE, SID)).rejects.toThrow(
      'branch-exists',
    );
    await expect(handlers.get(IPC.gitWorktreeAdd)!(null, BASE, SID)).rejects.not.toThrow(
      '/secret',
    );
  });

  it('remove builds the ref and delegates to the manager', async () => {
    const { d, removed } = deps();
    const { ctx, handlers } = captureHandlers();
    registerGitIpc(ctx, d);

    await handlers.get(IPC.gitWorktreeRemove)!(null, BASE, SID);

    expect(removed).toHaveLength(1);
    expect(removed[0]).toMatchObject({ baseProject: BASE, sessionId: SID });
  });

  it('list maps WorktreeInfo[] to WorktreeListItem[], omitting absent fields', async () => {
    const { d } = deps({
      list: vi.fn(async (): Promise<WorktreeInfo[]> => [
        { worktreeDir: '/wt/a', branch: 'devia/session-aaaa', head: 'abc123' },
        { worktreeDir: '/wt/b' },
      ]),
    });
    const { ctx, handlers } = captureHandlers();
    registerGitIpc(ctx, d);

    const out = await handlers.get(IPC.gitWorktreeList)!(null, BASE);

    expect(out).toEqual([
      { worktreeDir: '/wt/a', branch: 'devia/session-aaaa', head: 'abc123' },
      { worktreeDir: '/wt/b' },
    ]);
  });
});
