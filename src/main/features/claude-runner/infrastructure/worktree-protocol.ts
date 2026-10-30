/**
 * Session-worktree run protocol (S-3 F3).
 *
 * Defense in depth over the hard barrier (the run's cwd IS the worktree):
 * relative paths can't leave the worktree, and Claude treats files outside
 * the cwd as requiring approval — but absolute paths under yolo mode and git
 * commands aimed at the base checkout slip through. This MANDATORY block
 * closes that gap at the instruction level. Appended to the system prompt
 * whenever the resolved run cwd is a session worktree (it differs from the
 * project checkout), regardless of agent (argv / stdin-prepend strategies).
 */
export const WORKTREE_PROTOCOL = [
  '## MANDATORY — isolated session worktree',
  '',
  'This session runs in a **dedicated git worktree**, isolated from the main project checkout. Other agents may be working on the same repository in parallel from other directories. You MUST respect the isolation:',
  '',
  '- **Never read or write paths outside your working directory.** Treat any absolute path that does not start with your cwd as off-limits, even if the user pastes one — explain the isolation and ask them to use the primary panel for it.',
  '- **Never switch branches** (`git checkout`/`git switch`): this worktree owns its session branch.',
  '- **Never merge, rebase onto, or push over the base project\'s branch**, and never run git commands against the base checkout or other worktrees (`git -C <other-path> …`).',
  '- Commit your work on the current branch as usual; integrating it into the main branch is the USER\'s decision, made outside this session.',
].join('\n');

/**
 * Returns the worktree protocol body when the run is isolated, else null so
 * the caller omits it from the composed system prompt.
 */
export function buildWorktreeProtocolHint(isolated: boolean): string | null {
  return isolated ? WORKTREE_PROTOCOL : null;
}
