import type { AgentExtraArgsOptions, RuntimeAgentDef } from '../../domain/runtime-agent-def';
import { agentCapabilities } from '../detection/capabilities';
import { probeGeminiAuthStatus } from '../detection/probe-gemini-auth';
import { DEFAULT_MODEL_OPTION } from './shared';

/**
 * Gemini CLI adapter. Forces workspace trust via env var (the
 * `--skip-trust` CLI flag is unreliable across builds) and asks for the
 * JSON event stream. `--yolo` skips interactive approval prompts since
 * we run without a TTY.
 */
export const geminiAgentDef: RuntimeAgentDef = {
  id: 'gemini',
  name: 'Gemini CLI',
  bin: 'gemini',
  versionArgs: ['--version'],
  helpArgs: ['--help'],
  capabilityFlags: {
    '--include-directories': 'includeDirs',
  },
  fallbackModels: [
    DEFAULT_MODEL_OPTION,
    { id: 'gemini-3-pro-preview', label: 'gemini-3-pro-preview' },
    { id: 'gemini-3-flash-preview', label: 'gemini-3-flash-preview' },
    { id: 'gemini-2.5-pro', label: 'gemini-2.5-pro' },
    { id: 'gemini-2.5-flash', label: 'gemini-2.5-flash' },
    { id: 'gemini-2.5-flash-lite', label: 'gemini-2.5-flash-lite' },
  ],
  env: { GEMINI_CLI_TRUST_WORKSPACE: 'true' },
  envOverrideKeys: [
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY',
  ],
  buildArgs: (_prompt, _imagePaths, extraAllowedDirs = [], options = {}) => {
    // Approval mode is mode-aware and lives in `buildExtraArgs`.
    const caps = agentCapabilities.get('gemini') ?? {};
    const args = ['--output-format', 'stream-json'];
    if (options.model && options.model !== 'default') {
      args.push('--model', options.model);
    }
    // S-19 F2.2: whole-workspace visibility via Gemini's multi-dir context flag,
    // gated on the detected capability so an older build never sees an unknown
    // option. Confined modes pass the workspace root; apply-yolo omits it.
    const dirs = (extraAllowedDirs ?? []).filter(
      (d): d is string => typeof d === 'string' && d.length > 0,
    );
    if (dirs.length > 0 && caps['includeDirs']) {
      args.push('--include-directories', dirs.join(','));
    }
    return args;
  },
  promptViaStdin: true,
  streamFormat: 'json-event-stream',
  eventParser: 'gemini',
  // S-19 F2.1: proactively surface auth status in Settings (env key or login creds).
  authProbe: probeGeminiAuthStatus,
  // S-19 F0: Gemini CLI has no stable resume handle wired, so continuity comes
  // from re-seeding the transcript each turn (the parser never emits
  // `session_started`). Without this, every turn is a "first turn" and the
  // agent loses all prior conversation context.
  continuity: 'replay',
  installUrl: 'https://github.com/google-gemini/gemini-cli',
  // REV-AGENT-CORE-013: Gemini CLI has no system-prompt flag; prepend via stdin.
  systemPromptStrategy: 'stdin-prepend',
  // Mode-aware permissions via `--approval-mode` (replaces the deprecated
  // `--yolo`). `plan` is Gemini's real read-only mode. `apply` stays on `yolo`
  // for now: in non-interactive runs `auto_edit`/`default` block waiting for an
  // approval that has no TTY to answer it (a settings Policy Engine would let
  // `apply` confine without yolo — future work).
  buildExtraArgs: (opts: AgentExtraArgsOptions): string[] => {
    const mode = opts.capabilities?.mode ?? 'apply';
    if (mode === 'plan') {
      return ['--approval-mode', 'plan'];
    }
    return ['--approval-mode', 'yolo'];
  },
};
