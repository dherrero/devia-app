import { execFileSyncOnPath } from '../../cli-adapters/infrastructure/path-command';

function runGit(args: string[], cwd: string): string {
  try {
    return execFileSyncOnPath('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf-8',
    }).trim();
  } catch {
    return '';
  }
}

/**
 * Returns a compact one-liner with branch, dirty count and unpushed count
 * for the given project path. Returns null when the path is not a git repo
 * so the caller can omit the line from the system prompt.
 *
 * Intentionally avoids `git fetch` to keep latency near zero; we only report
 * local state. "behind origin" is therefore not available — by design.
 */
export function getGitStatusLine(cwd: string): string | null {
  if (!runGit(['rev-parse', '--git-dir'], cwd)) return null;

  const branchRaw = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  const branch =
    branchRaw === 'HEAD'
      ? `detached@${runGit(['rev-parse', '--short', 'HEAD'], cwd) || 'unknown'}`
      : branchRaw || 'unknown';

  const status = runGit(['status', '--porcelain'], cwd);
  const dirty = status ? status.split('\n').filter(Boolean).length : 0;
  const dirtyLabel = dirty === 0 ? 'clean' : `${dirty} dirty`;

  const ahead = runGit(['rev-list', '--count', '@{u}..HEAD'], cwd);
  const syncLabel =
    ahead === ''
      ? 'no upstream'
      : ahead === '0'
        ? 'pushed'
        : `${ahead} unpushed`;

  return `git: ${branch} (${dirtyLabel}, ${syncLabel})`;
}
