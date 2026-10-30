import { execFileSyncOnPath } from '../../cli-adapters/infrastructure/path-command';

/**
 * Commit ⇄ task traceability (E-DSK-12 T10).
 *
 * Closing commits carry a trailer line `Spec: S-<n>-T-<n>` so devia
 * can map commits back to kanban tasks. `parseSpecFooter` reads one
 * message; `scanCommitLinks` walks recent git history and returns the
 * commit shas grouped by task id, which the kanban use case folds into
 * each task's `linkedCommits`.
 *
 * git is invoked through the shared PATH-aware helper so Windows `.cmd` shims
 * and POSIX executables behave consistently. Best-effort: any git failure
 * yields an empty map.
 */

/** Matches the trailer `Spec: S-1-T-3` anywhere in a commit message. */
const SPEC_FOOTER_RE = /^Spec:\s*(S-\d+)-(T-\d+)\s*$/im;

/** Default history depth scanned for footers. */
const DEFAULT_MAX_COMMITS = 300;

export interface SpecRef {
  readonly specId: string;
  readonly taskId: string;
}

/** Canonical footer trailer for a task's closing commit. */
export function specFooter(specId: string, taskId: string): string {
  return `Spec: ${specId}-${taskId}`;
}

/** Extract the spec/task ref from a commit message, or null. */
export function parseSpecFooter(message: string): SpecRef | null {
  const m = SPEC_FOOTER_RE.exec(message);
  if (!m || !m[1] || !m[2]) return null;
  return { specId: m[1], taskId: m[2] };
}

/**
 * Walk recent history and group commit shas by the task id referenced
 * in their `Spec:` footer. Returns an empty map outside a git repo.
 */
export function scanCommitLinks(
  projectAbsPath: string,
  maxCommits = DEFAULT_MAX_COMMITS,
): Map<string, string[]> {
  const byTask = new Map<string, string[]>();
  let raw: string;
  try {
    // %H<US>%B<RS> — unit separator between sha and body, record
    // separator between commits, so multi-line bodies survive.
    raw = execFileSyncOnPath(
      'git',
      ['log', `-n${maxCommits}`, '--format=%H%x1f%B%x1e'],
      { cwd: projectAbsPath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
  } catch {
    return byTask;
  }

  for (const record of raw.split('\x1e')) {
    const trimmed = record.trim();
    if (!trimmed) continue;
    const sepIdx = trimmed.indexOf('\x1f');
    if (sepIdx < 0) continue;
    const sha = trimmed.slice(0, sepIdx).trim();
    const body = trimmed.slice(sepIdx + 1);
    const ref = parseSpecFooter(body);
    if (!ref || !sha) continue;
    const list = byTask.get(ref.taskId) ?? [];
    if (!list.includes(sha)) list.push(sha);
    byTask.set(ref.taskId, list);
  }
  return byTask;
}
