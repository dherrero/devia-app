import type { AgentExtraArgsOptions, RuntimeAgentDef } from '../../domain/runtime-agent-def';
import { agentCapabilities } from '../detection/capabilities';
import { probeClaudeAuthStatus } from '../detection/probe-claude-auth';
import { DEFAULT_MODEL_OPTION } from './shared';

/**
 * Default denylist for Claude — `WebSearch`/`WebFetch` are blocked because
 * they bypass our tool/network policy. Lives on the def (REV-AGENT-CORE-007)
 * so the use case can include it in `RunCapabilities.disallowedTools`.
 * Kept as a module-local constant for the `buildExtraArgs` fallback path used
 * by tests that bypass the use case.
 */
const DEFAULT_DISALLOWED = ['WebSearch', 'WebFetch'];

/**
 * Claude Code adapter — primary CLI Devia was built around. The default
 * permission mode stays `acceptEdits`; the apply-yolo run mode swaps to
 * `--dangerously-skip-permissions`.
 */
export const claudeAgentDef: RuntimeAgentDef = {
  id: 'claude',
  name: 'Claude Code',
  bin: 'claude',
  fallbackBins: ['openclaude'],
  versionArgs: ['--version'],
  helpArgs: ['-p', '--help'],
  capabilityFlags: {
    '--include-partial-messages': 'partialMessages',
    '--add-dir': 'addDir',
  },
  fallbackModels: [
    DEFAULT_MODEL_OPTION,
    { id: 'sonnet', label: 'Sonnet (alias)' },
    { id: 'opus', label: 'Opus (alias)' },
    { id: 'haiku', label: 'Haiku (alias)' },
    { id: 'claude-opus-4-5', label: 'claude-opus-4-5' },
    { id: 'claude-sonnet-4-5', label: 'claude-sonnet-4-5' },
    { id: 'claude-haiku-4-5', label: 'claude-haiku-4-5' },
  ],
  envOverrideKeys: [
    'CLAUDE_CONFIG_DIR',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_API_KEY',
  ],
  buildArgs: (_prompt, _imagePaths, extraAllowedDirs = [], options = {}) => {
    const caps = agentCapabilities.get('claude') ?? {};
    // `-p` puts claude in "headless one-shot" mode. We do NOT pass a positional
    // prompt: it arrives via stdin (gated by `promptViaStdin: true` below) so
    // we sidestep `spawn E2BIG` for long prompts on Linux.
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--verbose',
    ];
    if (caps['partialMessages']) {
      args.push('--include-partial-messages');
    }
    if (options.model && options.model !== 'default') {
      args.push('--model', options.model);
    }
    const dirs = (extraAllowedDirs ?? []).filter(
      (d): d is string => typeof d === 'string' && d.length > 0,
    );
    if (dirs.length > 0 && caps['addDir']) {
      args.push('--add-dir', ...dirs);
    }
    return args;
  },
  promptViaStdin: true,
  promptInputFormat: 'stream-json',
  streamFormat: 'claude-stream-json',
  installUrl: 'https://docs.anthropic.com/claude/docs/claude-code',
  buildResumeArgs: (agentSessionId) => ['--resume', agentSessionId],
  // REV-AGENT-CORE-013: Claude has a first-class `--append-system-prompt` flag.
  systemPromptStrategy: 'argv',
  defaultDisallowedTools: DEFAULT_DISALLOWED,
  // REV-AGENT-CORE-010: per-adapter auth probe lives on the def itself so the
  // central `auth-probe.ts` doesn't have to switch on agent id.
  authProbe: probeClaudeAuthStatus,
  buildExtraArgs: (opts: AgentExtraArgsOptions) => {
    // REV-AGENT-CORE-006: mode-aware permission shape.
    //   - plan       → keep all tools but block file-writers (denylist) and
    //                  use the strict default permission mode.
    //   - apply      → existing default (`--permission-mode acceptEdits`).
    //   - apply-yolo → unrestricted (`--dangerously-skip-permissions`).
    const mode = opts.capabilities?.mode ?? 'apply';
    const permissionArgs =
      mode === 'apply-yolo'
        ? ['--dangerously-skip-permissions']
        : mode === 'plan'
          ? ['--permission-mode', 'default']
          : ['--permission-mode', 'acceptEdits'];
    // REV-AGENT-CORE-005/007: prefer the per-run capabilities' denylist (which
    // already includes `defaultDisallowedTools` from the def + plan-mode adds)
    // when supplied. Falls back to the adapter's static default for callers
    // (e.g. tests) that bypass the use case.
    const disallowed = opts.capabilities?.disallowedTools ?? DEFAULT_DISALLOWED;
    return [
      ...permissionArgs,
      '--disallowedTools', disallowed.join(','),
      '--append-system-prompt', opts.systemPrompt,
    ];
  },
};
