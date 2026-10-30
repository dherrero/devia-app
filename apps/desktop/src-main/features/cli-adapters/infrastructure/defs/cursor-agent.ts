/**
 * Cursor-agent adapter (REV-AGENT-CORE-008).
 *
 * Cursor-agent is the headless CLI flavour of Cursor's coding agent. Stream
 * format is JSONL via stdout; the parser is registered as `'cursor-agent'`
 * in `select-parser.ts`. Auth probe lives in `probe-cursor-agent-auth.ts`.
 *
 * Invocation aligned with the validated open-design adapter: the canonical
 * headless form is `cursor-agent --print --output-format stream-json` (the old
 * `chat --json` shape is gone). `--trust` skips the workspace folder-trust
 * prompt in headless mode. Permission handling is mode-aware in
 * `buildExtraArgs`.
 */
import type { AgentExtraArgsOptions, RuntimeAgentDef, RuntimeModelOption } from '../../domain/runtime-agent-def';
import { probeCursorAgentAuthStatus } from '../detection/probe-cursor-agent-auth';
import { DEFAULT_MODEL_OPTION } from './shared';

/** Parses `cursor-agent models` output (one account-bound id per line). */
export function parseCursorAgentModels(stdout: string): RuntimeModelOption[] | null {
  const lines = String(stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
  if (lines.length === 0) return null;

  const out: RuntimeModelOption[] = [DEFAULT_MODEL_OPTION];
  const seen = new Set<string>([DEFAULT_MODEL_OPTION.id]);
  for (const line of lines) {
    if (/^(available models|models)$/i.test(line)) continue;
    const match = line.match(/^([A-Za-z0-9][A-Za-z0-9._/:@-]*)(?:\s+-\s+(.+))?$/);
    if (!match) continue;
    const id = match[1];
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, label: match[2]?.trim() || id });
  }
  return out.length > 1 ? out : null;
}

export const cursorAgentDef: RuntimeAgentDef = {
  id: 'cursor-agent',
  name: 'Cursor Agent',
  bin: 'cursor-agent',
  versionArgs: ['--version'],
  // `cursor-agent models` prints account-bound model ids per line. When the
  // user isn't authed it prints "No models available for this account." —
  // that's not a model list, so we detect it and fall back.
  listModels: {
    args: ['models'],
    timeoutMs: 5000,
    parse: (stdout) => {
      const trimmed = String(stdout || '').trim();
      if (!trimmed || /no models available/i.test(trimmed)) return null;
      return parseCursorAgentModels(trimmed);
    },
  },
  fallbackModels: [
    DEFAULT_MODEL_OPTION,
    { id: 'auto', label: 'auto' },
    { id: 'sonnet-4', label: 'sonnet-4' },
    { id: 'sonnet-4-thinking', label: 'sonnet-4-thinking' },
    { id: 'gpt-5', label: 'gpt-5' },
  ],
  envOverrideKeys: [
    'CURSOR_API_KEY',
    'CURSOR_CONFIG_DIR',
    'CURSOR_BASE_URL',
  ],
  buildArgs: (_prompt, _imagePaths, _extra, options = {}, runtimeContext = {}) => {
    // Cursor Agent does not use `-` as a "read prompt from stdin" sentinel —
    // it would treat the dash as the literal prompt. Keep stdin piped for the
    // prompt (promptViaStdin) and do not append a positional. Permission flags
    // are mode-aware in buildExtraArgs.
    const args = ['--print', '--output-format', 'stream-json', '--stream-partial-output', '--trust'];
    if (runtimeContext.cwd) {
      args.push('--workspace', runtimeContext.cwd);
    }
    if (options.model && options.model !== 'default') {
      args.push('--model', options.model);
    }
    return args;
  },
  promptViaStdin: true,
  streamFormat: 'json-event-stream',
  eventParser: 'cursor-agent',
  installUrl: 'https://cursor.sh/docs/cli',
  docsUrl: 'https://cursor.sh/docs/cli/quickstart',
  // REV-AGENT-CORE-013: cursor-agent has no system-prompt flag; prepend via stdin.
  systemPromptStrategy: 'stdin-prepend',
  // REV-AGENT-CORE-010: per-adapter auth probe.
  authProbe: probeCursorAgentAuthStatus,
  // Mode-aware permissions. `--mode plan` is Cursor's read-only planning mode.
  // `--force` allows the agent to act without per-command confirmation (the
  // validated headless behaviour). A future `--sandbox enabled` could confine
  // `apply` further once verified.
  buildExtraArgs: (opts: AgentExtraArgsOptions): string[] => {
    const mode = opts.capabilities?.mode ?? 'apply';
    if (mode === 'plan') {
      return ['--mode', 'plan'];
    }
    return ['--force'];
  },
};
