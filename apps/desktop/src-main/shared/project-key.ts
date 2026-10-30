/**
 * Converts an absolute project path into a filesystem-safe directory key.
 *
 * Rules (identical to Claude's `~/.claude/projects/` naming):
 *   - Replace every `/`, `\`, and `:` with `-`
 *   - Strip a leading `-` that arises on POSIX because `/` is the first char
 *
 * Referenced by FsSessionStore and worktree path resolution. The single
 * canonical copy lives here; call sites import from this module.
 */
export function projectKey(absolutePath: string): string {
  return absolutePath.replace(/[/\\:]/g, '-').replace(/^-/, '');
}
