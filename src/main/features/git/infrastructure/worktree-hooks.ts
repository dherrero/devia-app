import type { WorktreeLifecycleHooks } from '../../../shared/ports';

/** Runs a lifecycle hook without letting it throw (sync or async) into the worktree flow. */
export function notifyWorktreeHook<K extends keyof WorktreeLifecycleHooks>(
  hooks: WorktreeLifecycleHooks | undefined,
  name: K,
  args: Parameters<NonNullable<WorktreeLifecycleHooks[K]>>[0],
): void {
  if (!hooks) return;
  try {
    const fn = hooks[name] as ((a: typeof args) => unknown) | undefined;
    const out = fn?.call(hooks, args);
    if (out instanceof Promise) out.catch((err: unknown) => warn(name, err));
  } catch (err) {
    warn(name, err);
  }
}

function warn(name: string, err: unknown): void {
  console.warn(`[git:worktree-hook] ${name} failed:`, err instanceof Error ? err.message : String(err));
}
