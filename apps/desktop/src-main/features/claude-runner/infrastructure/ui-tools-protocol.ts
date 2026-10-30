import type { RunMode } from '../../../../shared/domain/run-capabilities';
import type { UiToolName } from '../../../../shared/domain/ui-tools';
import { missingUiCapabilities } from '../../../../shared/domain/ui-tools-policy';

/**
 * The two halves of teaching an agent how to reach the user (S-25 F1.2).
 *
 * `buildUiToolsHint` announces what this run HAS; `buildUiFallbackHint` covers
 * what it lacks. They are exact complements on purpose: announcing a tool the
 * run never got, or staying silent about a missing capability, both end the
 * same way — the model invents an answer or goes quiet.
 */

/**
 * One line per tool: WHEN to reach for it, not how. The JSON schema already
 * describes the how, and repeating it here pays for the same tokens twice in
 * the cached prompt prefix.
 */
const TOOL_LINES: Record<UiToolName, string> = {
  ask_user:
    'You MAY use `devia_ask_user` to let the user pick between a few discrete options: pass one or more `questions`, each with its `options` (label plus an optional description), and `multiSelect` when several answers are valid. It blocks until the user picks, so wait for the answer instead of assuming one. For open-ended clarifications, just ask inline in your normal text response.',
  todo: 'Use `devia_todo` to publish and keep updating your step list on any task with several steps, sending the COMPLETE list each time. It returns immediately and never asks anything.',
  plan_approve:
    'When your plan is ready, call `devia_plan_approve` instead of starting to edit files, listing its `steps`, and wait: the user approves, approves-and-runs, or rejects it with a comment you must act on.',
  request_review:
    'After a non-trivial change, call `devia_request_review` so the user can review your diff line by line; their comments come back as the tool result.',
  confirm:
    'Before a destructive or irreversible action (mass deletion, force push, dropping data), call `devia_confirm` and wait for the answer.',
  pick: 'When the user has to choose files or directories, call `devia_pick` instead of listing candidates in text and asking which one.',
  notify:
    'Use `devia_notify` when a long piece of work finishes or needs attention, so the user hears about it even without the window in front of them.',
  skill:
    'Call `devia_skill` with `op: "list"` to see the skills and sub-agents Devia manages for this project, then `op: "load"` for the one you need — a sub-agent loads as a role to take on when a task matches it.',
  send_file:
    'When the user asks for a file (screenshot, report, export) or a result is too long for the chat (one file beats ten messages), call `devia_send_file` with its path relative to your working directory. It is delivered after your reply, so do not also paste its content. Max 50 MB; secrets and credentials (.env, keys…) are refused.',
};

/**
 * Fallback text, per capability the run does NOT have. Only decision-carrying
 * tools appear here — see `missingUiCapabilities`.
 */
const FALLBACK_LINES: Partial<Record<UiToolName, string>> = {
  ask_user:
    '- **No multiple-choice tool.** Do not call `devia_ask_user`, `AskUserQuestion`, or any equivalent option picker: they are not loaded and the call is lost. Write the question as plain text, list the options inline (e.g. as a numbered list), and **end your turn**.',
  plan_approve:
    '- **No plan-approval card.** Present your plan as plain text and wait for an explicit go-ahead before writing anything.',
  request_review:
    '- **No diff-review card.** Summarise what you changed, per file, and ask for comments in plain text.',
  confirm:
    '- **No confirmation card.** State the destructive action plainly and wait for an explicit "yes" before performing it.',
};

/**
 * S-32: the run can reach the user's chat (`canSendFiles`) but `devia_send_file`
 * did not reach the agent (no MCP target, enterprise MCP, preference off). The
 * outbox is the channel that needs no tool — except in plan mode, where the
 * agent cannot write the copy. The path is the literal relative `outbox/` so
 * the prompt stays byte-stable across worktrees (cache prefix).
 */
const SEND_FILE_FALLBACK_LINE =
  '- **No file-send tool.** To send a file to the user, copy it into `outbox/` in your working directory; Devia sends everything there after your reply, so do not also paste its content. Max 50 MB; secrets and credentials (.env, keys…) are refused.';
const SEND_FILE_PLAN_LINE =
  '- **No file sending in this run.** You cannot send files in plan mode: give the file\'s path in your reply instead.';
const SEND_FILE_HEADER = '## Sending files to the user';

const FALLBACK_HEADER = '## Reaching the user — no interactive UI in this run';

const FALLBACK_FOOTER = [
  '- The session is multi-turn and **persistent**: the user answers in their next message, in this same session, with the full context intact. You do not need to re-explain anything or start over.',
  '- If a reasonable default exists, take it, say explicitly which assumption you made, and carry on rather than stopping to ask.',
].join('\n');

/** Announcement of the tools this run actually got. Null when it got none. */
export function buildUiToolsHint(advertised: readonly UiToolName[]): string | null {
  const lines = advertised.map((name) => TOOL_LINES[name]).filter(Boolean);
  return lines.length > 0 ? lines.join(' ') : null;
}

/** What the fallback needs to know beyond the delivered set. */
export interface UiFallbackContext {
  /**
   * The run talks through a connected chat that accepts files (S-32). Absent
   * or false → no file paragraph at all, so a run without a relay composes
   * exactly the prompt it did before.
   */
  canSendFiles?: boolean;
  mode?: RunMode;
}

function sendFileFallbackLine(advertised: readonly UiToolName[], ctx: UiFallbackContext): string | null {
  if (ctx.canSendFiles !== true || advertised.includes('send_file')) return null;
  return ctx.mode === 'plan' ? SEND_FILE_PLAN_LINE : SEND_FILE_FALLBACK_LINE;
}

/**
 * Plain-text protocol for the capabilities this run lacks. Null when nothing is
 * missing — an agent with every tool must not be handed a paragraph about
 * tools it can call.
 */
export function buildUiFallbackHint(
  advertised: readonly UiToolName[],
  ctx: UiFallbackContext = {},
): string | null {
  const missing = missingUiCapabilities(advertised);
  const lines = missing.map((name) => FALLBACK_LINES[name]).filter((l): l is string => Boolean(l));
  const fileLine = sendFileFallbackLine(advertised, ctx);
  if (lines.length === 0) {
    // Only the file channel is missing: the "no interactive UI" header and the
    // multi-turn footer would be false here.
    return fileLine ? [SEND_FILE_HEADER, '', fileLine].join('\n') : null;
  }
  return [FALLBACK_HEADER, '', ...lines, ...(fileLine ? [fileLine] : []), FALLBACK_FOOTER].join('\n');
}
