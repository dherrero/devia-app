/**
 * GitHub Copilot CLI adapter.
 *
 * Targets the standalone `copilot` CLI (`@github/copilot`) — NOT the legacy
 * `gh copilot` extension. Non-interactive runs use `--output-format json`
 * (JSONL, parsed by `copilot-event-stream.ts`). The prompt is piped via stdin
 * (we omit `-p`) to avoid Windows `spawn ENAMETOOLONG` for large composed
 * prompts. Permissions are mode-aware in `buildExtraArgs`; Copilot's allow/deny
 * tool patterns (`Kind(arg)`, deny wins) let `apply` confine without full yolo.
 */
import type { AgentExtraArgsOptions, RuntimeAgentDef } from '../../domain/runtime-agent-def';
import { DEFAULT_MODEL_OPTION } from './shared';

export const copilotAgentDef: RuntimeAgentDef = {
  id: 'copilot',
  name: 'GitHub Copilot CLI',
  bin: 'copilot',
  versionArgs: ['--version'],
  fallbackModels: [
    DEFAULT_MODEL_OPTION,
    { id: 'claude-sonnet-4.6', label: 'Claude Sonnet 4.6' },
    { id: 'gpt-5.2', label: 'GPT-5.2' },
  ],
  envOverrideKeys: [
    'GITHUB_TOKEN',
    'GH_TOKEN',
  ],
  buildArgs: (_prompt, _imagePaths, extraAllowedDirs = [], options = {}) => {
    // Omit `-p`: the prompt is piped via stdin (promptViaStdin) so large
    // composed prompts don't blow the Windows command-line limit. Permission
    // flags are mode-aware in buildExtraArgs.
    const args = ['--output-format', 'json'];
    const dirs = (extraAllowedDirs ?? []).filter(
      (d): d is string => typeof d === 'string' && d.length > 0,
    );
    for (const d of dirs) args.push('--add-dir', d);
    if (options.model && options.model !== 'default') {
      args.push('--model', options.model);
    }
    return args;
  },
  promptViaStdin: true,
  streamFormat: 'json-event-stream',
  eventParser: 'copilot',
  installUrl: 'https://docs.github.com/copilot/github-copilot-in-the-cli/installing-github-copilot-in-the-cli',
  docsUrl:    'https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference',
  // REV-AGENT-CORE-013: copilot has no system-prompt flag; prepend via stdin.
  systemPromptStrategy: 'stdin-prepend',
  // Mode-aware permissions. `--allow-all-tools` is required for non-interactive
  // runs (otherwise Copilot blocks on every tool approval); deny rules take
  // precedence even over allow-all, so plan/apply confine via `--deny-tool`.
  buildExtraArgs: (opts: AgentExtraArgsOptions): string[] => {
    const mode = opts.capabilities?.mode ?? 'apply';
    if (mode === 'plan') {
      return ['--allow-all-tools', '--deny-tool', 'write', '--deny-tool', 'shell'];
    }
    if (mode === 'apply-yolo') {
      return ['--allow-all'];
    }
    return ['--allow-all-tools', '--deny-tool', 'shell(rm:*)', '--deny-tool', 'shell(git push)'];
  },
};
