import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { RuntimeAgentDef, RuntimeContext } from '../../cli-adapters/domain/runtime-agent-def';
import { checkPromptArgvBudget } from '../../cli-adapters/infrastructure/prompt-budget';
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

/** `stdin-prepend` / `argv-prepend` header. Neutral wording that travels across model families. */
export function buildSystemPromptHeader(systemPrompt: string | undefined): string {
  if (!systemPrompt || systemPrompt.trim().length === 0) return '';
  return `[System]\n${systemPrompt.trim()}\n\n[User]\n`;
}

/** Claude's stream-json first user message. */
export function buildStreamJsonUserMessage(prompt: string): string {
  return (
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: prompt }] },
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

function stdinPlanFor(def: RuntimeAgentDef, prompt: string, systemPrompt: string): StdinPlan {
  // Stdio JSON-RPC agents: the session driver sends the prompt itself.
  if (def.streamFormat === 'acp-json-rpc' || def.streamFormat === 'pi-rpc') return { kind: 'session' };
  if (def.promptViaStdin !== true) return { kind: 'none' };
  if (def.promptInputFormat === 'stream-json') {
    return { kind: 'stream', payload: buildStreamJsonUserMessage(prompt) };
  }
  const header = def.systemPromptStrategy === 'stdin-prepend' ? buildSystemPromptHeader(systemPrompt) : '';
  return { kind: 'text', payload: header + prompt };
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
      ? buildSystemPromptHeader(systemPrompt) + plan.prompt
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
      stdin: stdinPlanFor(def, plan.prompt, systemPrompt),
      cleanup: () => systemPromptFile?.cleanup(),
    },
  };
}
