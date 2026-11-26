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

/** The value of a role the user chose NOT to split: "the main (effective) agent". */
export const MAIN_AGENT = 'main';

/**
 * Role → agentId, or {@link MAIN_AGENT}. A role absent from the map has never
 * been asked about; one set to `main` was asked and the user kept it with the
 * main agent, so it is not asked again.
 */
export type RoleAgentMap = Partial<Record<WorkerRole, string>>;

/** True when the role runs on an agent other than the main one. */
export function isRoleSplit(map: RoleAgentMap | undefined, role: WorkerRole): boolean {
  const value = map?.[role];
  return value !== undefined && value !== MAIN_AGENT;
}

/** Repair a persisted role map: known roles only, each with a non-empty agent id. */
export function sanitizeRoleAgents(raw: unknown): RoleAgentMap {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: RoleAgentMap = {};
  for (const role of WORKER_ROLES) {
    const value = (raw as Record<string, unknown>)[role];
    if (typeof value === 'string' && value.length > 0) out[role] = value;
  }
  return out;
}

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
  /** {@link MAIN_AGENT} = the main (effective) agent, i.e. do not split this role. */
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
  const options: AssignOption[] = [{ key: 'a', agentId: MAIN_AGENT }];
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
    map[role] = option.agentId;
  });
  return retryRoles.length > 0 ? { ok: false, retryRoles } : { ok: true, map };
}

const WORKER_KEY_PREFIX = 'devia-worker:';

/**
 * The run identity a worker's events are routed by. Deterministic and distinct
 * per parent, task and attempt, so two panes of the same project never collide.
 */
export function workerRunKey(parentKey: string, taskId: string, attempt: number): string {
  return `${WORKER_KEY_PREFIX}${parentKey}:${taskId}:${attempt}`;
}

export function isWorkerRunKey(key: string): boolean {
  return key.startsWith(WORKER_KEY_PREFIX);
}

const WORKER_KEY_RE = /^devia-worker:(.+):([A-Za-z0-9][A-Za-z0-9._-]*):(\d+)$/;

/** The parts of a worker run key, or null when it is not one. The parent may contain colons. */
export function parseWorkerRunKey(key: string): { parentKey: string; taskId: string; attempt: number } | null {
  const match = WORKER_KEY_RE.exec(key);
  if (!match) return null;
  return { parentKey: match[1] as string, taskId: match[2] as string, attempt: Number(match[3]) };
}

export type WorkerState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'timeout';

/** One worker as the registry tracks it and the renderer draws it. */
export interface WorkerRun {
  id: string;
  parentKey: string;
  turnId: string;
  taskId: string;
  role: WorkerRole;
  agentId: string;
  /** The run identity the worker's own events are routed by. */
  runKey: string;
  state: WorkerState;
  status?: WorkerStatus;
  startedAt?: number;
  endedAt?: number;
}
