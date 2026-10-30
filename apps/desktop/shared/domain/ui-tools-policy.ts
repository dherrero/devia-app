import type { RunMode } from './run-capabilities';
import { UI_TOOL_NAMES, type UiToolName } from './ui-tools';

/**
 * Which `devia-ui` tools a given run is offered (S-25 F0.4).
 *
 * The set is resolved ONCE per run, before the system prompt is composed, and
 * travels to the server on argv. It must be deterministic: the tool schemas sit
 * in the agent's cached prompt prefix, so a set that changed mid-run would
 * invalidate the cache on every turn.
 *
 * Pure: no Node, no config reads, no capability probing. Callers pass what they
 * already know.
 */

/**
 * Base policy per mode.
 *
 * `plan_approve` is plan-only — in apply the plan is already approved, and
 * offering it there invites the agent to re-litigate a decision the user made.
 * `confirm`, `request_review` and `pick` are apply-only — plan blocks the
 * file-writers, so there is nothing to confirm, review or pick a target for.
 */
const BY_MODE: Record<RunMode, readonly UiToolName[]> = {
  plan: ['ask_user', 'todo', 'plan_approve', 'skill', 'send_file'],
  apply: ['ask_user', 'todo', 'request_review', 'confirm', 'pick', 'notify', 'skill', 'send_file'],
  'apply-yolo': [
    'ask_user',
    'todo',
    'request_review',
    'confirm',
    'pick',
    'notify',
    'skill',
    'send_file',
  ],
};

/**
 * A remote (Telegram) user cannot click anything, so every INTERACTIVE tool is
 * withheld and the agent gets the plain-text fallback protocol instead. The
 * three that survive need no interaction — and `notify` is more useful there
 * than on the desktop, because the chat is the only channel.
 *
 * `send_file` (S-32) needs no click either, and only exists where there is a
 * chat to send to — see `canSendFiles`.
 *
 * Side benefit, and the reason this is a hard filter rather than a UI tweak:
 * a remote turn then carries three or four schemas in its cached prefix
 * instead of seven.
 */
const REMOTE_ALLOWED: readonly UiToolName[] = ['todo', 'notify', 'skill', 'send_file'];

export interface UiToolPolicyInput {
  mode: RunMode;
  /** A run started from the Telegram relay. */
  isRemote: boolean;
  /** Whether the MCP server can be delivered to this agent at all. */
  delivered: boolean;
  /** User preference per tool. An absent entry means "use the mode default". */
  preferences?: Partial<Record<UiToolName, boolean>>;
  /**
   * `skill` is pointless when Devia manages neither a skill nor a sub-agent
   * for this project (it serves both — S-30 T-356).
   */
  hasSkills?: boolean;
  /** `notify` needs somewhere to notify: a window or a connected chat relay. */
  canNotify?: boolean;
  /**
   * `send_file` needs a connected chat to send to. Opt-in, unlike the other
   * capability flags: absent means OFF, so a run without a relay advertises
   * exactly what it did before the tool existed.
   */
  canSendFiles?: boolean;
}

/**
 * The advertised set, in canonical order.
 *
 * A user preference can only NARROW the mode policy, never widen it: enabling
 * `confirm` in settings must not surface it in plan mode, where it is
 * meaningless.
 */
export function resolveAdvertisedUiTools(input: UiToolPolicyInput): UiToolName[] {
  if (!input.delivered) return [];

  const base = new Set(BY_MODE[input.mode] ?? BY_MODE.apply);
  const out: UiToolName[] = [];
  for (const name of UI_TOOL_NAMES) {
    if (!base.has(name)) continue;
    if (input.isRemote && !REMOTE_ALLOWED.includes(name)) continue;
    if (input.preferences?.[name] === false) continue;
    if (name === 'skill' && input.hasSkills === false) continue;
    if (name === 'notify' && input.canNotify === false) continue;
    if (name === 'send_file' && input.canSendFiles !== true) continue;
    out.push(name);
  }
  return out;
}

/**
 * Tools this build can actually draw a card for.
 *
 * The policy above describes INTENT (and the token budget is measured against
 * it); this list describes what the renderer can show. The main process serves
 * every tool through one generic path, so what is missing for the rest is the
 * card — and advertising a BLOCKING tool with no card hangs the run until the
 * kill timeout. Each F2.x task adds its own name here as its card lands.
 */
export const IMPLEMENTED_UI_TOOLS: readonly UiToolName[] = [
  'ask_user',
  'todo',
  'plan_approve',
  'notify',
  'skill',
  'confirm',
  'pick',
  'request_review',
  'send_file',
];

/** Narrow an advertised set to the tools this build can actually serve. */
export function wiredUiTools(
  advertised: readonly UiToolName[],
  implemented: readonly UiToolName[] = IMPLEMENTED_UI_TOOLS,
): UiToolName[] {
  return advertised.filter((name) => implemented.includes(name));
}

/** Tools that are NOT offered but whose capability the agent still needs. */
export function missingUiCapabilities(advertised: readonly UiToolName[]): UiToolName[] {
  return NEEDS_FALLBACK.filter((name) => !advertised.includes(name));
}

/**
 * Only the tools that carry a DECISION need a plain-text fallback. `todo`,
 * `notify`, `pick`, `skill` and `send_file` are conveniences: writing a paragraph of prompt
 * about their absence would cost context and buy nothing.
 */
const NEEDS_FALLBACK: readonly UiToolName[] = [
  'ask_user',
  'plan_approve',
  'request_review',
  'confirm',
];
