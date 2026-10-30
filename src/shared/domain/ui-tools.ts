/**
 * Domain contracts for the `devia-ui` MCP server (S-25) — the single server
 * that exposes Devia's interface tools to whichever CLI agent is active.
 *
 * Pure types + pure functions only: this module is imported by the main
 * process, by the Angular renderer AND by the out-of-process MCP server, so it
 * must stay free of Node and Electron.
 *
 * Every `normalize*` function is DEFENSIVE by contract: the input comes from a
 * language model, so it clamps, coerces and drops instead of throwing. The one
 * exception is a payload with no usable content at all, which returns null so
 * the caller can answer with a readable tool error.
 */

export type UiToolName =
  | 'ask_user'
  | 'todo'
  | 'plan_approve'
  | 'request_review'
  | 'confirm'
  | 'pick'
  | 'notify'
  | 'skill'
  | 'send_file';

export const UI_TOOL_NAMES: readonly UiToolName[] = [
  'ask_user',
  'todo',
  'plan_approve',
  'request_review',
  'confirm',
  'pick',
  'notify',
  'skill',
  'send_file',
] as const;

/**
 * A blocking tool holds the agent's turn until the user answers, so it is the
 * only kind that arms the runner's kill timer. Fire-and-forget tools return an
 * ack immediately and must never stall a run.
 */
export type UiToolKind = 'blocking' | 'fire_and_forget';

export const UI_TOOL_KIND: Record<UiToolName, UiToolKind> = {
  ask_user: 'blocking',
  todo: 'fire_and_forget',
  plan_approve: 'blocking',
  request_review: 'blocking',
  confirm: 'blocking',
  pick: 'blocking',
  notify: 'fire_and_forget',
  skill: 'fire_and_forget',
  send_file: 'fire_and_forget',
};

/** `ask_user` keeps its historical public name so S-24 transcripts still resolve. */
export function uiToolPublicName(name: UiToolName): string {
  return `devia_${name}`;
}

export function uiToolFromPublicName(publicName: string): UiToolName | null {
  const bare = publicName.startsWith('devia_') ? publicName.slice('devia_'.length) : publicName;
  return (UI_TOOL_NAMES as readonly string[]).includes(bare) ? (bare as UiToolName) : null;
}

export function isBlockingUiTool(name: UiToolName): boolean {
  return UI_TOOL_KIND[name] === 'blocking';
}

/**
 * What the settings panel needs to describe one tool, including what it COSTS.
 *
 * `schemaChars` is measured against the real advertised schema in the main
 * process — the same bytes the budget test guards — rather than duplicated as
 * a table here, which would drift the first time a description changes.
 */
export interface UiToolCatalogEntry {
  name: UiToolName;
  publicName: string;
  description: string;
  kind: UiToolKind;
  schemaChars: number;
}

/**
 * One "always allow" the user granted for `devia_confirm` (S-25 F2.4).
 *
 * Lives here, not next to its store, because the settings panel reads it over
 * the bridge and `shared/` must never depend on `src/main/`.
 */
export interface ConfirmationGrant {
  /** Normalised action text — the exact key a future call must match. */
  action: string;
  /** The action as the user saw it. */
  label: string;
  grantedAt: string;
  agentId?: string;
}

/** Rough chars→tokens ratio; see the S-25 budget test for where it comes from. */
export const CHARS_PER_TOKEN = 3.5;

export function approxTokens(chars: number): number {
  return Math.round(chars / CHARS_PER_TOKEN);
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const UI_LIMITS = {
  text: 2_000,
  longText: 20_000,
  todoItems: 50,
  pickPaths: 200,
  reviewComments: 200,
  sendFilesPerRun: 10,
  /** Telegram's own caption cap. */
  sendFileCaption: 1_024,
  path: 4_096,
} as const;

// ---------------------------------------------------------------------------
// devia_todo
// ---------------------------------------------------------------------------

export type TodoStatus = 'pending' | 'in_progress' | 'done';

export interface TodoItem {
  id: string;
  text: string;
  status: TodoStatus;
  note?: string;
}

export interface TodoListInput {
  items: TodoItem[];
}

// ---------------------------------------------------------------------------
// devia_plan_approve
// ---------------------------------------------------------------------------

export interface PlanStep {
  /** `step-<n>`, assigned in order. The agent reports progress on these ids. */
  id: string;
  text: string;
}

export interface PlanApproveInput {
  title: string;
  plan: string;
  risks?: string;
  filesTouched?: string[];
  /** Ordered steps the execution stepper is built from (S-28 T-336). */
  steps?: PlanStep[];
}

export const PLAN_STEP_LIMITS = { count: 20, text: 200 } as const;

export type PlanDecision = 'approve' | 'approve_and_run' | 'reject';

export interface PlanApproveResult {
  decision: PlanDecision;
  comment?: string;
}

/**
 * A decided plan as it is kept in the thread (S-28 T-337): what was proposed
 * plus what the user did with it. Nothing here is interactive any more.
 */
export interface PlanRecord extends PlanApproveInput {
  decision: PlanDecision;
  comment?: string;
  decidedAt: number;
}

/** Plain-text rendering for `ChatMessage.text`, so text-only consumers keep working. */
export function planRecordText(record: PlanRecord): string {
  const verdict = record.decision === 'reject' ? 'Plan rechazado' : 'Plan aprobado';
  const steps =
    record.steps && record.steps.length > 0
      ? `\n${record.steps.map((st, i) => `${i + 1}. ${st.text}`).join('\n')}`
      : '';
  const comment = record.comment ? `\nMotivo: ${record.comment}` : '';
  return `${verdict}: ${record.title}${steps}${comment}`;
}

// ---------------------------------------------------------------------------
// devia_request_review
// ---------------------------------------------------------------------------

export interface RequestReviewInput {
  intro?: string;
  paths?: string[];
}

export interface RequestReviewResult {
  /** `empty`: nothing to review, answered without the user (S-28 T-335). */
  decision: 'send' | 'cancel' | 'empty';
  prompt?: string;
}

// ---------------------------------------------------------------------------
// devia_confirm
// ---------------------------------------------------------------------------

export interface ConfirmInput {
  action: string;
  detail?: string;
  danger?: boolean;
}

export type ConfirmDecision = 'yes' | 'no' | 'always';

export interface ConfirmResult {
  decision: ConfirmDecision;
}

// ---------------------------------------------------------------------------
// devia_pick
// ---------------------------------------------------------------------------

export interface PickInput {
  intro?: string;
  multiple?: boolean;
  filter?: 'file' | 'dir' | 'any';
  root?: string;
}

export interface PickResult {
  paths: string[];
}

// ---------------------------------------------------------------------------
// devia_notify
// ---------------------------------------------------------------------------

export type NotifyLevel = 'info' | 'warn' | 'error';

export interface NotifyInput {
  title: string;
  body?: string;
  level?: NotifyLevel;
}

// ---------------------------------------------------------------------------
// devia_skill
// ---------------------------------------------------------------------------

export type SkillInput = { op: 'list' } | { op: 'load'; name: string };

// ---------------------------------------------------------------------------
// devia_send_file (S-32)
// ---------------------------------------------------------------------------

export type SendFileAs = 'auto' | 'document' | 'photo';

/** What the agent asks for. The path is untrusted until the guards resolve it. */
export interface SendFileInput {
  path: string;
  caption?: string;
  as?: SendFileAs;
}

/** What travels once the path has been resolved and validated. */
export interface SendFileRequest {
  absPath: string;
  name: string;
  size: number;
  mime: string;
  caption?: string;
  as: SendFileAs;
}

/**
 * The normalizer's output. The enriched fields are present when the MCP server
 * already resolved the file and forwarded it to the main process, which
 * normalizes the same payload again and must revalidate them, not trust them.
 */
export type NormalizedSendFile = SendFileInput &
  { as: SendFileAs } &
  Partial<Pick<SendFileRequest, 'absPath' | 'name' | 'size' | 'mime'>>;

// ---------------------------------------------------------------------------
// Normalizers
// ---------------------------------------------------------------------------

export function normalizeTodoInput(input: unknown): TodoListInput | null {
  const raw = readArray(asRecord(input)?.['items'] ?? asRecord(input)?.['todos']);
  if (raw === null) return null;

  const items: TodoItem[] = [];
  let inProgressTaken = false;
  for (const entry of raw.slice(0, UI_LIMITS.todoItems)) {
    const text = typeof entry === 'string' ? clamp(entry, UI_LIMITS.text) : null;
    if (text !== null) {
      items.push({ id: `t${items.length + 1}`, text, status: 'pending' });
      continue;
    }
    const record = asRecord(entry);
    if (!record) continue;
    const label = readText(record, ['text', 'content', 'title'], UI_LIMITS.text);
    if (label === null) continue;

    let status = readTodoStatus(record['status']);
    // At most one item may be in progress: several would make the progress
    // indicator meaningless, so later ones degrade instead of rejecting the call.
    if (status === 'in_progress') {
      if (inProgressTaken) status = 'pending';
      else inProgressTaken = true;
    }
    const id = readText(record, ['id'], 64) ?? `t${items.length + 1}`;
    const note = readText(record, ['note', 'detail'], UI_LIMITS.text);
    items.push({ id, text: label, status, ...(note !== null && { note }) });
  }

  return items.length > 0 ? { items } : null;
}

export function normalizePlanApproveInput(input: unknown): PlanApproveInput | null {
  const record = asRecord(input);
  if (!record) return null;
  const plan = readText(record, ['plan', 'body', 'content', 'markdown'], UI_LIMITS.longText);
  if (plan === null) return null;
  const title = readText(record, ['title', 'header'], UI_LIMITS.text) ?? 'Plan propuesto';
  const risks = readText(record, ['risks', 'risk'], UI_LIMITS.text);
  const filesTouched = readStringList(record['filesTouched'] ?? record['files'], 100);
  const steps = readPlanSteps(record['steps']);
  return {
    title,
    plan,
    ...(risks !== null && { risks }),
    ...(filesTouched.length > 0 && { filesTouched }),
    ...(steps.length > 0 && { steps }),
  };
}

/**
 * Accepts plain strings (what the schema asks for) and `{ text }` objects (what
 * an agent used to `devia_todo` tends to send). Ids are always re-assigned in
 * order, so the follow-up prompt and the stepper agree on them whatever the
 * agent passed.
 */
function readPlanSteps(value: unknown): PlanStep[] {
  const raw = readArray(value);
  if (raw === null) return [];
  const steps: PlanStep[] = [];
  for (const entry of raw) {
    if (steps.length >= PLAN_STEP_LIMITS.count) break;
    const text =
      typeof entry === 'string'
        ? clamp(entry, PLAN_STEP_LIMITS.text)
        : readText(asRecord(entry) ?? {}, ['text', 'title', 'content'], PLAN_STEP_LIMITS.text);
    if (text === null) continue;
    steps.push({ id: `step-${steps.length + 1}`, text });
  }
  return steps;
}

export function normalizeRequestReviewInput(input: unknown): RequestReviewInput {
  const record = asRecord(input);
  if (!record) return {};
  const intro = readText(record, ['intro', 'message', 'summary'], UI_LIMITS.text);
  const paths = readStringList(record['paths'] ?? record['files'], 100);
  return { ...(intro !== null && { intro }), ...(paths.length > 0 && { paths }) };
}

export function normalizeConfirmInput(input: unknown): ConfirmInput | null {
  const record = asRecord(input);
  if (!record) {
    const bare = typeof input === 'string' ? clamp(input, UI_LIMITS.text) : null;
    return bare === null ? null : { action: bare };
  }
  const action = readText(record, ['action', 'command', 'question'], UI_LIMITS.text);
  if (action === null) return null;
  const detail = readText(record, ['detail', 'details', 'reason'], UI_LIMITS.text);
  return {
    action,
    ...(detail !== null && { detail }),
    ...(record['danger'] === true && { danger: true }),
  };
}

export function normalizePickInput(input: unknown): PickInput {
  const record = asRecord(input);
  if (!record) return {};
  const intro = readText(record, ['intro', 'message', 'question'], UI_LIMITS.text);
  const root = readText(record, ['root', 'dir'], UI_LIMITS.text);
  const filter = readPickFilter(record['filter'] ?? record['type']);
  return {
    ...(intro !== null && { intro }),
    ...(record['multiple'] === true && { multiple: true }),
    ...(filter !== null && { filter }),
    ...(root !== null && { root }),
  };
}

export function normalizeNotifyInput(input: unknown): NotifyInput | null {
  const record = asRecord(input);
  if (!record) {
    const bare = typeof input === 'string' ? clamp(input, UI_LIMITS.text) : null;
    return bare === null ? null : { title: bare };
  }
  const title = readText(record, ['title', 'message', 'text'], UI_LIMITS.text);
  if (title === null) return null;
  const body = readText(record, ['body', 'detail'], UI_LIMITS.text);
  const level = readNotifyLevel(record['level'] ?? record['severity']);
  return { title, ...(body !== null && { body }), ...(level !== null && { level }) };
}

export function normalizeSkillInput(input: unknown): SkillInput | null {
  const record = asRecord(input);
  if (!record) return null;
  const op = readText(record, ['op', 'operation', 'action'], 32)?.toLowerCase() ?? null;
  if (op === 'list' || op === null) return { op: 'list' };
  if (op !== 'load' && op !== 'get' && op !== 'read') return null;
  const name = readText(record, ['name', 'skill', 'id'], 128);
  return name === null ? null : { op: 'load', name };
}

export function normalizeSendFileInput(input: unknown): NormalizedSendFile | null {
  if (typeof input === 'string') {
    const bare = readPath(input);
    return bare === null ? null : { path: bare, as: 'auto' };
  }
  const record = asRecord(input);
  if (!record) return null;
  const path = readPathField(record, ['path', 'file', 'filePath', 'absPath']);
  if (path === null) return null;
  const caption = readText(record, ['caption', 'message', 'text'], UI_LIMITS.sendFileCaption);
  const absPath = readPathField(record, ['absPath']);
  const name = readText(record, ['name'], 255);
  const mime = readText(record, ['mime'], 255);
  const size = record['size'];
  return {
    path,
    as: readSendFileAs(record['as']),
    ...(caption !== null && { caption }),
    ...(absPath !== null && { absPath }),
    ...(name !== null && { name }),
    ...(mime !== null && { mime }),
    ...(typeof size === 'number' && Number.isSafeInteger(size) && size >= 0 && { size }),
  };
}

/**
 * Dispatcher over the per-tool normalizers, for the main-process poller, which
 * only knows the tool by name. Returns null when the payload has nothing
 * usable, so the caller can answer with a readable error instead of drawing an
 * empty card. `ask_user` is absent on purpose: it keeps the S-24 normalizer in
 * `question-ask.ts`, and with it the untouched renderer path.
 */
export function normalizeUiToolInput(tool: UiToolName, input: unknown): unknown | null {
  switch (tool) {
    case 'todo':
      return normalizeTodoInput(input);
    case 'plan_approve':
      return normalizePlanApproveInput(input);
    case 'request_review':
      return normalizeRequestReviewInput(input);
    case 'confirm':
      return normalizeConfirmInput(input);
    case 'pick':
      return normalizePickInput(input);
    case 'notify':
      return normalizeNotifyInput(input);
    case 'skill':
      return normalizeSkillInput(input);
    case 'send_file':
      return normalizeSendFileInput(input);
    case 'ask_user':
      return input;
  }
}

// ---------------------------------------------------------------------------
// Result renderers — what the agent reads back as the tool result.
//
// Always TEXT, never opaque JSON: the result has to read as a clear instruction
// about what to do next, because it is the only thing the model sees.
// ---------------------------------------------------------------------------

export function renderPlanApproveResult(result: PlanApproveResult): string {
  const comment = result.comment ? `\nUser comment: ${result.comment}` : '';
  switch (result.decision) {
    case 'approve_and_run':
      return (
        'The user APPROVED the plan and switched Devia to apply mode. ' +
        'End your turn now with a one-line confirmation — do not start editing in this turn. ' +
        'Devia has already queued a follow-up instruction that will execute the approved plan ' +
        'in the next turn, with write access.' + comment
      );
    case 'approve':
      return (
        'The user APPROVED the plan but did NOT ask to execute it yet. ' +
        'End your turn with a short confirmation and wait for the user to start the work.' + comment
      );
    case 'reject':
      return (
        'The user REJECTED the plan. Revise it according to their comment and propose a new plan ' +
        'in this same turn — do not repeat the rejected approach.' + comment
      );
  }
}

/**
 * The instruction Devia queues for the NEXT turn when the user picks "approve
 * and run".
 *
 * It exists because the current run cannot execute the plan: the sandbox and
 * permission flags (`--permission-mode`, `--sandbox`, `--dangerously-*`) are
 * fixed in the argv of the already-spawned process, so a run started in `plan`
 * can never become `apply` mid-flight. The tool result tells the agent to end
 * its turn; this prompt is what actually starts the work, under a fresh process
 * with write access.
 *
 * The plan is inlined verbatim rather than referenced, so the follow-up run does
 * not depend on the agent "remembering" what it proposed.
 */
export function buildPlanFollowUpPrompt(plan: PlanApproveInput): string {
  const files =
    plan.filesTouched && plan.filesTouched.length > 0
      ? `\n\nFiles the plan expects to touch:\n${plan.filesTouched.map((f) => `- ${f}`).join('\n')}`
      : '';
  const steps =
    plan.steps && plan.steps.length > 0
      ? `\n\nBefore starting, publish \`devia_todo\` with exactly these steps (same ids and texts), ` +
        `then mark each one \`in_progress\` and \`done\` as you go — Devia draws its progress stepper from them:\n` +
        plan.steps.map((st) => `- ${st.id}: ${st.text}`).join('\n')
      : '';
  return (
    `The user approved this plan and Devia switched to apply mode. Execute it now.\n\n` +
    `## ${plan.title}\n\n${plan.plan}${files}${steps}`
  );
}

export function renderConfirmResult(result: ConfirmResult): string {
  switch (result.decision) {
    case 'yes':
      return 'The user CONFIRMED. Proceed with the action.';
    case 'always':
      return (
        'The user CONFIRMED and chose to always allow this exact action in this project. ' +
        'Proceed, and do not ask again for the same action.'
      );
    case 'no':
      return (
        'The user REFUSED the action. Do NOT perform it. ' +
        'Either continue with the rest of the work or explain what you need instead.'
      );
  }
}

export function renderPickResult(result: PickResult): string {
  if (result.paths.length === 0) {
    return (
      'The user did not select anything. Continue with a reasonable default and state your ' +
      'assumption, or ask in plain text.'
    );
  }
  return `The user selected:\n${result.paths.map((p) => `- ${p}`).join('\n')}`;
}

export function renderRequestReviewResult(result: RequestReviewResult): string {
  if (result.decision === 'empty') {
    return 'There are no uncommitted changes to review. Continue with your work.';
  }
  if (result.decision === 'cancel' || !result.prompt) {
    return 'The user closed the review without leaving comments. Continue with your work.';
  }
  return `The user reviewed the diff and left these comments:\n\n${result.prompt}`;
}

/**
 * Classify what the user decided, for the audit log.
 *
 * Keyed to the markers the renderers above emit — a controlled contract, not a
 * guess at free text — and only for the two tools where the DECISION is the
 * thing worth auditing. Anything else returns null, and the audit entry records
 * just the outcome.
 */
export function classifyUiDecision(tool: UiToolName, answer: string): string | null {
  if (tool === 'confirm') {
    if (answer.includes('do not ask again')) return 'always';
    if (answer.includes('CONFIRMED')) return 'yes';
    if (answer.includes('REFUSED')) return 'no';
    return null;
  }
  if (tool === 'plan_approve') {
    if (answer.includes('REJECTED')) return 'rejected';
    if (answer.includes('apply mode')) return 'approved_and_run';
    if (answer.includes('APPROVED')) return 'approved';
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readArray(value: unknown): unknown[] | null {
  return Array.isArray(value) && value.length > 0 ? value : null;
}

function clamp(value: string, max: number): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function readText(
  record: Record<string, unknown>,
  keys: readonly string[],
  max: number,
): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string') {
      const clamped = clamp(value, max);
      if (clamped !== null) return clamped;
    }
  }
  return null;
}

function readStringList(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const clamped = clamp(entry, UI_LIMITS.text);
    if (clamped !== null) out.push(clamped);
    if (out.length >= max) break;
  }
  return out;
}

function readTodoStatus(value: unknown): TodoStatus {
  if (value === 'in_progress' || value === 'active' || value === 'running') return 'in_progress';
  if (value === 'done' || value === 'completed' || value === 'complete') return 'done';
  return 'pending';
}

function readPickFilter(value: unknown): 'file' | 'dir' | 'any' | null {
  if (value === 'file' || value === 'dir' || value === 'any') return value;
  if (value === 'directory' || value === 'folder') return 'dir';
  return null;
}

/**
 * A path is never clamped: a truncated path would name a DIFFERENT file. An
 * over-long one, or one carrying a NUL byte, is rejected outright.
 */
function readPath(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > UI_LIMITS.path || trimmed.includes('\0')) return null;
  return trimmed;
}

function readPathField(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string') {
      const path = readPath(value);
      if (path !== null) return path;
    }
  }
  return null;
}

function readSendFileAs(value: unknown): SendFileAs {
  if (value === 'document' || value === 'photo') return value;
  if (value === 'file') return 'document';
  if (value === 'image') return 'photo';
  return 'auto';
}

function readNotifyLevel(value: unknown): NotifyLevel | null {
  if (value === 'info' || value === 'warn' || value === 'error') return value;
  if (value === 'warning') return 'warn';
  return null;
}
