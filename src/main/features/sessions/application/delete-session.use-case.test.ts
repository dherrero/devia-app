import { describe, it, expect, vi } from 'vitest';
import { DeleteSessionUseCase } from './delete-session.use-case';
import type { ProjectRegistry, ProjectRecord, SessionStore, StateStore } from '../../../shared/ports';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BASE = '/workspace/my-project';
const ACTIVE = '11111111-2222-3333-4444-555555555555';
const OTHER = '99999999-8888-7777-6666-555555555555';

function build(
  running: boolean,
  opts: { worktreeBranch?: string; runningKeys?: string[] } = {},
) {
  const record = {
    name: BASE,
    isRunning: running,
    newSession: false,
    activeSessionId: ACTIVE,
    agentSessionId: 'native-1',
    agentSessionAgentId: 'claude',
  } as ProjectRecord;
  const runningKeys = new Set(opts.runningKeys ?? (running ? [BASE] : []));
  const registry = {
    find: () => record,
    isRunning: (key: string) => runningKeys.has(key),
  } as unknown as ProjectRegistry;
  const deleteOne = vi.fn();
  const sessions = {
    isValidSessionId: (id: unknown): id is string => typeof id === 'string' && UUID_RE.test(id),
    deleteOne,
    load: vi.fn(() =>
      opts.worktreeBranch !== undefined ? { id: ACTIVE, worktreeBranch: opts.worktreeBranch } : { id: ACTIVE },
    ),
  } as unknown as SessionStore;
  const state = { save: vi.fn() } as unknown as StateStore;
  const cleanupWorktree = vi.fn();
  const useCase = new DeleteSessionUseCase({ registry, sessions, state, cleanupWorktree });
  return { useCase, record, deleteOne, state, cleanupWorktree };
}

describe('DeleteSessionUseCase — hard guard (S-2 F0.4)', () => {
  it('refuses to delete the ACTIVE session while its project runs (SESSION_BUSY)', () => {
    const { useCase, record, deleteOne } = build(true);

    expect(() => useCase.execute(BASE, ACTIVE)).toThrowError('SESSION_BUSY');
    expect(deleteOne).not.toHaveBeenCalled();
    expect(record.activeSessionId).toBe(ACTIVE);
  });

  it('deleting a NON-active session while the project runs stays allowed', () => {
    const { useCase, deleteOne } = build(true);

    const result = useCase.execute(BASE, OTHER);

    expect(result.wasActive).toBe(false);
    expect(deleteOne).toHaveBeenCalledWith(BASE, OTHER);
  });

  it('deleting the active session while idle clears the pointer as before', () => {
    const { useCase, record, deleteOne, state } = build(false);

    const result = useCase.execute(BASE, ACTIVE);

    expect(result.wasActive).toBe(true);
    expect(deleteOne).toHaveBeenCalledWith(BASE, ACTIVE);
    expect(record.activeSessionId).toBeNull();
    expect(state.save).toHaveBeenCalled();
  });
});

describe('DeleteSessionUseCase — worktree teardown (S-3)', () => {
  it('tears down worktree + branch when the persisted session carries worktreeBranch', () => {
    const { useCase, deleteOne, cleanupWorktree } = build(false, {
      worktreeBranch: 'devia/session-99999999',
    });

    useCase.execute(BASE, OTHER);

    expect(deleteOne).toHaveBeenCalledWith(BASE, OTHER);
    expect(cleanupWorktree).toHaveBeenCalledWith(BASE, OTHER, 'devia/session-99999999');
  });

  it('skips teardown for sessions without a worktree (primary checkout)', () => {
    const { useCase, cleanupWorktree } = build(false);

    useCase.execute(BASE, OTHER);

    expect(cleanupWorktree).not.toHaveBeenCalled();
  });

  it('refuses to delete a session running as a split pane (runKey === sessionId)', () => {
    const { useCase, deleteOne, cleanupWorktree } = build(false, {
      worktreeBranch: 'devia/session-99999999',
      runningKeys: [OTHER],
    });

    expect(() => useCase.execute(BASE, OTHER)).toThrowError('SESSION_BUSY');
    expect(deleteOne).not.toHaveBeenCalled();
    expect(cleanupWorktree).not.toHaveBeenCalled();
  });

  it('a cleanup failure never breaks the delete (best-effort)', () => {
    const { useCase, deleteOne, cleanupWorktree } = build(false, {
      worktreeBranch: 'devia/session-99999999',
    });
    cleanupWorktree.mockImplementation(() => {
      throw new Error('git exploded');
    });

    const result = useCase.execute(BASE, OTHER);

    expect(result.wasActive).toBe(false);
    expect(deleteOne).toHaveBeenCalledWith(BASE, OTHER);
  });
});
