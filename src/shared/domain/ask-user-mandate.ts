/**
 * Tags and reminder of the "ask with the card" mandate (S-46). Live in
 * shared/domain because the prompt builder (claude-runner) writes the block and
 * the agent invocation code (agents/shared) must recognise it without importing
 * each other, like `turn-context-tags.ts`.
 *
 * The block itself is only ever generated for a desktop run that was delivered
 * `devia_ask_user`; a Telegram run never gets it, nor anything below.
 */
export const ASK_USER_MANDATE_TAG = 'devia-ask-user-protocol';

/** Wraps the prepended system text of agents that have no system-prompt channel. */
export const SYSTEM_PROMPT_WRAPPER_TAG = 'devia-system-prompt';

/** Closes the user's message of those same agents (models weigh the last instruction most). */
export const REMINDER_TAG = 'devia-reminder';

export const ASK_USER_REMINDER =
  '**REMINDER: EVERY QUESTION FOR THE USER GOES THROUGH `devia_ask_user`. NEVER END YOUR REPLY WITH A QUESTION OR A LIST OF OPTIONS IN PLAIN TEXT.**';

/** True when the composed system text carries the mandate block. */
export function hasAskUserMandate(systemPrompt: string | undefined): boolean {
  return systemPrompt !== undefined && systemPrompt.includes(`<${ASK_USER_MANDATE_TAG}`);
}
