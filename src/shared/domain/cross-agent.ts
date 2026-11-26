/**
 * Cross-agent workers (S-56): pure domain types and helpers. No Node, no Electron.
 *
 * The roles are the Devia Method's own (implementer, task reviewer), never
 * free-form: a fixed set is cacheable per project and easy to ask about.
 */

export type WorkerRole = 'implementer' | 'reviewer';
export const WORKER_ROLES: readonly WorkerRole[] = ['implementer', 'reviewer'];

/** Report statuses of the Devia Method's implementer/reviewer contract. */
export type WorkerStatus = 'DONE' | 'DONE_WITH_CONCERNS' | 'NEEDS_CONTEXT' | 'BLOCKED';

/** Role → agentId. A missing role means "the main (effective) agent". */
export type RoleAgentMap = Partial<Record<WorkerRole, string>>;

export interface WorkerReport {
  status: WorkerStatus;
  summary: string;
  commits: string[];
  /** The worker's final text, untouched. */
  raw: string;
}

const STATUS_RE = /^\s*STATUS:\s*(DONE_WITH_CONCERNS|DONE|NEEDS_CONTEXT|BLOCKED)\b.*$/im;
const COMMIT_RE = /\bcommits?[\s:]+([0-9a-f]{7,40})\b/gi;

/**
 * Parse a worker's final text. Never throws: a text without a recognisable
 * `STATUS:` line is reported as BLOCKED so the controller sees the failure
 * instead of a silent success.
 */
export function parseWorkerReport(finalText: string): WorkerReport {
  const raw = finalText ?? '';
  const match = STATUS_RE.exec(raw);
  const commits = [...new Set([...raw.matchAll(COMMIT_RE)].map((m) => m[1] as string))];
  if (!match) {
    return { status: 'BLOCKED', summary: raw.trim(), commits, raw };
  }
  const summary = (raw.slice(0, match.index) + raw.slice(match.index + match[0].length)).trim();
  return { status: match[1] as WorkerStatus, summary, commits, raw };
}

export interface RenderableWorkerReport extends WorkerReport {
  agentId: string;
  role: WorkerRole;
  taskId: string;
}

/** The text the controller receives. Truncates the tail and says so. */
export function renderWorkerReport(report: RenderableWorkerReport, maxChars = 8000): string {
  const header = `[${report.agentId} · ${report.role} · ${report.taskId}] ${report.status}`;
  const body = report.summary;
  if (body.length <= maxChars) return `${header}\n${body}`;
  return `${header}\n${body.slice(0, maxChars)}\n… (report truncated: ${body.length - maxChars} more characters)`;
}

export interface AssignOption {
  key: string;
  /** `'main'` = the main (effective) agent, i.e. do not split this role. */
  agentId: string;
}

export interface AssignQuestion {
  roles: WorkerRole[];
  options: AssignOption[];
}

const OPTION_KEYS = 'abcdefghijklmnopqrstuvwxyz';

/** `a` is always the main agent; the rest follow in the given (stable) order. */
export function buildAssignQuestion(
  roles: readonly WorkerRole[],
  availableAgentIds: readonly string[],
  mainAgentId: string,
): AssignQuestion {
  const others = availableAgentIds.filter((id) => id !== mainAgentId).slice(0, OPTION_KEYS.length - 1);
  const options: AssignOption[] = [{ key: 'a', agentId: 'main' }];
  others.forEach((agentId, i) => options.push({ key: OPTION_KEYS[i + 1] as string, agentId }));
  return { roles: [...roles], options };
}

export type AssignReplyResult = { ok: true; map: RoleAgentMap } | { ok: false; retryRoles: WorkerRole[] };

const REPLY_TOKEN_RE = /(\d+)\s*[.)]?\s*([a-z])\b/gi;

/**
 * Parse `1. b  2. c` (also `1b 2c`, `1) B`). Deterministic, no LLM. Returns no
 * partial map: when any role is missing or invalid, only those roles come back
 * in `retryRoles`.
 */
export function parseAssignReply(text: string, question: AssignQuestion): AssignReplyResult {
  const chosen = new Map<number, string>();
  for (const m of (text ?? '').matchAll(REPLY_TOKEN_RE)) {
    const index = Number(m[1]) - 1;
    if (index < 0 || index >= question.roles.length) continue;
    chosen.set(index, (m[2] as string).toLowerCase());
  }
  const map: RoleAgentMap = {};
  const retryRoles: WorkerRole[] = [];
  question.roles.forEach((role, index) => {
    const key = chosen.get(index);
    const option = key === undefined ? undefined : question.options.find((o) => o.key === key);
    if (!option) {
      retryRoles.push(role);
      return;
    }
    if (option.agentId !== 'main') map[role] = option.agentId;
  });
  return retryRoles.length > 0 ? { ok: false, retryRoles } : { ok: true, map };
}
