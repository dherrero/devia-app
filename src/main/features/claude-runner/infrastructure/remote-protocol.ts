/**
 * Remote-origin (Telegram) run protocol.
 *
 * A run started from the Telegram bot reaches the user through a one-message-
 * at-a-time chat relay, so they cannot see or click Devia's UI. Since S-24 the
 * question tool is Devia's own MCP server, so a remote run simply does not get
 * it — and the agent is told how to ask instead by `ui-tools-protocol.ts`,
 * which is shared with every other run that lacks the tool.
 *
 * This body therefore keeps ONLY what is specific to the chat relay. Keep it
 * that way: repeating the fallback rules here in different words is worse than
 * saying nothing, because the model has to reconcile two versions of the same
 * instruction.
 */
export const REMOTE_PROTOCOL = [
  '## Remote session — Telegram chat relay',
  '',
  'The user is talking to you through a **remote chat relay (Telegram)**, not the Devia desktop UI. This changes how you must interact:',
  '',
  '- The user **cannot see or click** option pickers, cards, diffs, or any interactive UI. Anything you need them to read has to be in the text of your reply.',
  '- Keep replies concise and chat-friendly; the user reads them on a phone.',
  '- Prefer to **proceed autonomously**: when a reasonable default exists, take it and state the assumption you made, instead of stopping to ask.',
].join('\n');

/**
 * S-32: appended only when this run can actually send files to the chat
 * (`canSendFiles`) — otherwise it would promise something impossible. WHAT, not
 * how: the mechanics (tool or `outbox/`) belong to `ui-tools-protocol.ts`.
 */
export const REMOTE_SEND_FILE_LINE =
  '- If the user asks for a file (or the answer is a long artifact), send it as a file instead of pasting it.';

/**
 * Canned tool result delivered to the agent if it somehow manages to emit an
 * interactive question during a remote run (safety net — the tool is not
 * delivered, so this only catches an agent's own built-in picker). Phrased as
 * the "answer" the agent receives so it converts the question into plain text.
 */
export const REMOTE_QUESTION_UNAVAILABLE_ANSWER = [
  '⚠️ Interactive questions are not available: the user is on a remote chat (Telegram) and cannot click options.',
  'Do not try to ask interactively again. Re-ask your question as plain text in your normal reply (list any options inline) and end your turn — the user will answer in their next message, in this same session.',
  'If a reasonable default exists, proceed with it and state the assumption instead of asking.',
].join(' ');

/**
 * Returns the remote protocol body for remote-origin runs, else null so the
 * caller omits it from the composed system prompt.
 */
export function buildRemoteProtocolHint(isRemote: boolean, canSendFiles = false): string | null {
  if (!isRemote) return null;
  return canSendFiles ? `${REMOTE_PROTOCOL}\n${REMOTE_SEND_FILE_LINE}` : REMOTE_PROTOCOL;
}
