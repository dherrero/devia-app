import type { AgentExtraArgsOptions, RuntimeAgentDef } from '../../domain/runtime-agent-def';
import { probeOpencodeAuthStatus } from '../detection/probe-opencode-auth';
import { DEFAULT_MODEL_OPTION, parseLineSeparatedModels } from './shared';

/**
 * OpenCode adapter. The npm-published binary is `opencode-cli`; older
 * installs ship just `opencode`. `opencode models` prints one
 * `provider/model` per line, parsed via `parseLineSeparatedModels`.
 */
export const opencodeAgentDef: RuntimeAgentDef = {
  id: 'opencode',
  name: 'OpenCode',
  bin: 'opencode-cli',
  fallbackBins: ['opencode'],
  versionArgs: ['--version'],
  listModels: {
    args: ['models'],
    parse: parseLineSeparatedModels,
    timeoutMs: 8000,
  },
  fallbackModels: [
    DEFAULT_MODEL_OPTION,
    { id: 'anthropic/claude-sonnet-4-5', label: 'anthropic/claude-sonnet-4-5' },
    { id: 'openai/gpt-5', label: 'openai/gpt-5' },
    { id: 'google/gemini-2.5-pro', label: 'google/gemini-2.5-pro' },
  ],
  envOverrideKeys: [
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'GOOGLE_API_KEY',
  ],
  buildArgs: (_prompt, _imagePaths, _extra, options = {}) => {
    // Permission handling is mode-aware and lives in `buildExtraArgs`.
    const args = ['run', '--format', 'json'];
    if (options.model && options.model !== 'default') {
      args.push('--model', options.model);
    }
    return args;
  },
  promptViaStdin: true,
  streamFormat: 'json-event-stream',
  eventParser: 'opencode',
  // S-19 F2.1: proactively surface auth status in Settings (env key or auth.json).
  authProbe: probeOpencodeAuthStatus,
  // S-30 T-351: native resume. Every event carries `sessionID` (the decoder
  // emits `session_started` from the first one) and `run --session <id>`
  // continues it — verified against opencode 1.19.3. Replaces the S-19
  // transcript replay, which re-sent the whole history every turn.
  continuity: 'native',
  buildResumeArgs: (agentSessionId) => ['--session', agentSessionId],
  installUrl: 'https://github.com/sst/opencode',
  // REV-AGENT-CORE-013: OpenCode has no system-prompt CLI flag — the launcher
  // prepends a `[System]...[User]` header to the stdin payload instead.
  systemPromptStrategy: 'stdin-prepend',
  // Mode-aware permissions. `plan` uses OpenCode's built-in read-only `plan`
  // agent. `apply`/`apply-yolo` use `--dangerously-skip-permissions` for now
  // (non-interactive runs can't answer an `ask`); a per-command `permission`
  // policy in `opencode.json` would let `apply` confine without it — future work.
  buildExtraArgs: (opts: AgentExtraArgsOptions): string[] => {
    const mode = opts.capabilities?.mode ?? 'apply';
    if (mode === 'plan') {
      return ['--agent', 'plan'];
    }
    return ['--dangerously-skip-permissions'];
  },
};
