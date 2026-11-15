import { describe, expect, it, vi } from 'vitest';
import { notifyWorktreeHook } from './worktree-hooks';

describe('notifyWorktreeHook', () => {
  it('forwards the args', () => {
    const onRemoved = vi.fn();
    notifyWorktreeHook({ onRemoved }, 'onRemoved', { worktreePath: '/w' });
    expect(onRemoved).toHaveBeenCalledWith({ worktreePath: '/w' });
  });

  it('swallows a throwing hook and a rejecting hook', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const args = { baseProject: '/b', worktreePath: '/w' };
    expect(() => notifyWorktreeHook({ onCreated: () => { throw new Error('boom'); } }, 'onCreated', args)).not.toThrow();
    const rejecting = { onCreated: (): void => (Promise.reject(new Error('late')) as unknown as void) };
    expect(() => notifyWorktreeHook(rejecting, 'onCreated', args)).not.toThrow();
    await new Promise((r) => setImmediate(r));
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('is a no-op without hooks', () => {
    expect(() => notifyWorktreeHook(undefined, 'onRemoved', { worktreePath: '/w' })).not.toThrow();
  });
});
