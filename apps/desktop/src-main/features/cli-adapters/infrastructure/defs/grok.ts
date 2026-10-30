import type { RuntimeAgentDef } from '../../domain/runtime-agent-def';
import { probeGrokAuthStatus } from '../detection/probe-grok-auth';

/**
 * Grok CLI adapter — grok-dev (Vibe Kit, `@ai-sdk/xai`). First-class:
 * headless `grok -p "<prompt>" --format json` emits a JSONL event stream
 * (step_start / text / tool_use / step_finish{usage} / error), each line
 * carrying `sessionID`. Continuity is NATIVE: `-s/--session <id>` re-opens the
 * prior conversation from grok's SQLite store (`~/.grok/grok.db`), so resuming
 * recovers full context (like Codex/Claude).
 *
 * The prompt is delivered via argv (`-p <PROMPT>`, value-required) — grok-dev
 * reads it from argv, not stdin — so `promptViaStdin` stays false and the
 * launcher guards the argv byte budget. grok-dev exposes no `--system` flag and
 * no `--effort` flag (reasoning effort is per-model in its settings), so the
 * Devia system prompt is delivered via `systemPromptStrategy: 'argv-prepend'`
 * (S-21 T-226): the launcher inlines a `[System] ... [User]` header into the
 * `-p` value, counted against `maxPromptArgBytes`.
 *
 * NOTE: requires a grok-dev whose headless mode supports `--format json` +
 * `--session` (older `grok` builds without those flags would reject them).
 * The parser tolerates non-JSON output so a stray line never breaks a run.
 */
export const grokAgentDef: RuntimeAgentDef = {
  id: 'grok',
  name: 'Grok',
  bin: 'grok',
  versionArgs: ['--version'],
  fallbackModels: [
    { id: 'grok-4.3', label: 'grok-4.3 (flagship)' },
    { id: 'grok-4.20-multi-agent-0309', label: 'grok-4.20 multi-agent' },
    { id: 'grok-4.20-0309-reasoning', label: 'grok-4.20 reasoning' },
    { id: 'grok-4.20-non-reasoning', label: 'grok-4.20 non-reasoning' },
    { id: 'grok-3-mini', label: 'grok-3-mini (budget)' },
  ],
  providerType: 'cli',
  applicability: 'direct',
  streamFormat: 'json-event-stream',
  eventParser: 'grok',
  continuity: 'native',
  authProbe: probeGrokAuthStatus,
  envOverrideKeys: ['GROK_API_KEY', 'GROK_BASE_URL', 'GROK_MODEL'],
  // grok-dev reads the prompt from argv (-p); guard the OS argv byte limit.
  // Generous headroom: the system prompt is inlined into this same value.
  maxPromptArgBytes: 200_000,
  // No `--system` flag: the launcher inlines the system header into the -p value.
  systemPromptStrategy: 'argv-prepend',
  installUrl: 'https://x.ai',
  buildArgs: (prompt, _imagePaths, _extra, options = {}) => {
    // Headless JSONL: `-p <PROMPT> --format json [--model <m>]`. Order is not
    // load-bearing (commander), but keep -p first for readability.
    const args = ['-p', prompt, '--format', 'json'];
    if (options.model) args.push('--model', options.model);
    return args;
  },
  // Native resume: `--session <id>` re-opens grok's stored conversation.
  buildResumeArgs: (agentSessionId) => ['--session', agentSessionId],
};
