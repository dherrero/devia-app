/**
 * Optional observer of session-worktree lifecycle.
 *
 * Implemented by the composition root (it forwards to features that keep
 * per-checkout state, e.g. the code graph) and consumed by the git feature,
 * which calls it best-effort: a hook can neither fail nor delay a worktree
 * operation. Both paths are ABSOLUTE.
 */
export interface WorktreeLifecycleHooks {
  onCreated?(args: { baseProject: string; worktreePath: string; sessionId?: string }): void;
  onRemoved?(args: { worktreePath: string }): void;
}
