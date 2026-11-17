import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { RuntimeAgentDef, RuntimeContext } from '../../cli-adapters/domain/runtime-agent-def';
import { checkPromptArgvBudget } from '../../cli-adapters/infrastructure/prompt-budget';
import {
  ASK_USER_REMINDER,
  REMINDER_TAG,
  SYSTEM_PROMPT_WRAPPER_TAG,
  hasAskUserMandate,
} from '../../../../shared/domain/ask-user-mandate';
import { sanitizeTurnContextTags } from '../../../../shared/domain/turn-context-tags';
import type { AgentRunPlan, StdinPlan } from '../domain';

/**
 * How a `RuntimeAgentDef` turns a run into argv + stdin (moved out of the
 * launcher in S-30 T-347 so the launcher only spawns). Shared by every mapper:
 * a def still describes its CLI's flags; the mapper decides what to pass.
 * Covers every system-prompt strategy a def can declare.
 */
export interface DefInvocation {
  readonly args: string[];
  readonly stdin: StdinPlan;
  /** Removes the system-prompt temp file, when one was written. */
  cleanup(): void;
}

export type DefInvocationResult =
  | { readonly ok: true; readonly invocation: DefInvocation }
  | { readonly ok: false; readonly error: string };

/**
 * `stdin-prepend` / `argv-prepend` header. Neutral wording that travels across model families.
 *
 * S-46: when the system text carries the ask_user mandate, it is wrapped in a
 * `devia-system-prompt` tag marked mandatory (these agents have no real system
 * channel, so Devia's text rides inside the user's turn). Without the mandate —
 * a Telegram run, or a run without `ask_user` — the header is byte-identical to
 * what it always was.
 */
export function buildSystemPromptHeader(systemPrompt: string | undefined): string {
  if (!systemPrompt || systemPrompt.trim().length === 0) return '';
  const body = systemPrompt.trim();
  const text = hasAskUserMandate(systemPrompt)
    ? `<${SYSTEM_PROMPT_WRAPPER_TAG} priority="mandatory">\n${body}\n</${SYSTEM_PROMPT_WRAPPER_TAG}>`
    : body;
  return `[System]\n${text}\n\n[User]\n`;
}

/**
 * S-46: closing reminder after the user's text for the same agents (models weigh
 * the last instruction most). Empty unless the system text carries the mandate.
 */
export function buildSystemPromptTail(systemPrompt: string | undefined): string {
  if (!hasAskUserMandate(systemPrompt)) return '';
  return `\n\n<${REMINDER_TAG}>${ASK_USER_REMINDER}</${REMINDER_TAG}>`;
}

/**
 * Claude's stream-json first user message. With a per-turn context block (S-40)
 * it is the FIRST content block, apart from the user's text. The user's text is
 * ALWAYS stripped of a copy of the block's tag, also on the many resumed turns
 * that carry no block: a forged one would otherwise be the latest "binding" block
 * in the session. Text without the tag is untouched, byte for byte.
 */
export function buildStreamJsonUserMessage(prompt: string, turnContext?: string): string {
  const text = sanitizeTurnContextTags(prompt);
  const content =
    turnContext === undefined
      ? [{ type: 'text', text }]
      : [
          { type: 'text', text: turnContext },
          { type: 'text', text },
        ];
  return (
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
    }) + '\n'
  );
}

/**
 * Materialise the system prompt for an `'argv-file'` adapter (pi). OS temp dir,
 * owner-only on POSIX. Null when the strategy does not apply, the prompt is
 * empty, or the write fails (the run goes on without it — logged).
 */
export function writeSystemPromptFile(
  def: RuntimeAgentDef,
  systemPrompt: string | undefined,
  runId: string,
): { path: string; cleanup(): void } | null {
  if (def.systemPromptStrategy !== 'argv-file' || !def.buildSystemPromptFileArgs) return null;
  if (!systemPrompt || systemPrompt.trim().length === 0) return null;
  const file = path.join(os.tmpdir(), `devia-system-prompt-${def.id}-${runId}.md`);
  try {
    fs.writeFileSync(file, systemPrompt, { encoding: 'utf8', mode: 0o600 });
  } catch (err) {
    console.warn(`[agents:${def.id}] could not write the system prompt file: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  let removed = false;
  return {
    path: file,
    cleanup(): void {
      if (removed) return;
      removed = true;
      try { fs.unlinkSync(file); } catch { /* already gone */ }
    },
  };
}

function stdinPlanFor(def: RuntimeAgentDef, prompt: string, systemPrompt: string, turnContext?: string): StdinPlan {
  // Stdio JSON-RPC agents: the session driver sends the prompt itself.
  if (def.streamFormat === 'acp-json-rpc' || def.streamFormat === 'pi-rpc') return { kind: 'session' };
  if (def.promptViaStdin !== true) return { kind: 'none' };
  if (def.promptInputFormat === 'stream-json') {
    return { kind: 'stream', payload: buildStreamJsonUserMessage(prompt, turnContext) };
  }
  const header = def.systemPromptStrategy === 'stdin-prepend' ? buildSystemPromptHeader(systemPrompt) : '';
  const tail = def.systemPromptStrategy === 'stdin-prepend' ? buildSystemPromptTail(systemPrompt) : '';
  return { kind: 'text', payload: header + prompt + tail };
}

/**
 * argv = `def.buildArgs(...)` + `extraArgs` + the system-prompt file flags,
 * in that order (the same order the launcher used).
 */
export function buildDefInvocation(
  def: RuntimeAgentDef,
  plan: AgentRunPlan,
  systemPrompt: string,
  extraArgs: readonly string[],
): DefInvocationResult {
  // `argv-prepend` (Grok): no system flag, so the header rides inside the
  // prompt argv — and that combined string is what the budget must measure.
  const effectivePrompt =
    def.systemPromptStrategy === 'argv-prepend' && def.promptViaStdin !== true
      ? buildSystemPromptHeader(systemPrompt) + plan.prompt + buildSystemPromptTail(systemPrompt)
      : plan.prompt;
  const budgetError = checkPromptArgvBudget(def, effectivePrompt);
  if (budgetError !== null) return { ok: false, error: budgetError.message };

  const runtimeContext: RuntimeContext = {
    cwd: plan.cwd,
    ...(plan.resumeSessionId !== undefined && { resumeSessionId: plan.resumeSessionId }),
  };
  const builtArgs = def.buildArgs(
    effectivePrompt,
    [...plan.imagePaths],
    [...plan.extraAllowedDirs],
    { model: plan.model ?? null, reasoning: plan.reasoning ?? null },
    runtimeContext,
  );
  const systemPromptFile = writeSystemPromptFile(def, systemPrompt, plan.runId);
  const args = [
    ...builtArgs,
    ...extraArgs,
    ...(systemPromptFile ? def.buildSystemPromptFileArgs?.(systemPromptFile.path) ?? [] : []),
  ];
  return {
    ok: true,
    invocation: {
      args,
      stdin: stdinPlanFor(def, plan.prompt, systemPrompt, plan.turnContext),
      cleanup: () => systemPromptFile?.cleanup(),
    },
  };
}
