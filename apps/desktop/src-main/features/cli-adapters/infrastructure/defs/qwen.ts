import type { AgentExtraArgsOptions, RuntimeAgentDef } from '../../domain/runtime-agent-def';
import { DEFAULT_MODEL_OPTION } from './shared';

/**
 * Qwen Code CLI adapter.
 *
 * Qwen Code is a Gemini-CLI fork. It emits plain text (no stable structured
 * event stream), so it stays on the plain-text parser. The prompt is piped via
 * stdin (Qwen reads piped stdin when no positional prompt is supplied — a bare
 * `-` is rejected). Permissions are mode-aware in `buildExtraArgs`: `plan` uses
 * the read-only `--approval-mode plan`, everything else auto-approves so the
 * non-interactive run doesn't block waiting for a TTY approval.
 */
export const qwenAgentDef: RuntimeAgentDef = {
  id: 'qwen',
  name: 'Qwen Code',
  bin: 'qwen',
  versionArgs: ['--version'],
  fallbackModels: [
    DEFAULT_MODEL_OPTION,
    { id: 'qwen3-coder-plus', label: 'qwen3-coder-plus' },
    { id: 'qwen3-coder-flash', label: 'qwen3-coder-flash' },
  ],
  envOverrideKeys: [
    'DASHSCOPE_API_KEY',
    'QWEN_API_KEY',
    'QWEN_BASE_URL',
  ],
  buildArgs: (_prompt, _imagePaths, _extra, options = {}) => {
    // Permission/approval flag is mode-aware in buildExtraArgs.
    const args: string[] = [];
    if (options.model && options.model !== 'default') {
      args.push('--model', options.model);
    }
    return args;
  },
  promptViaStdin: true,
  streamFormat: 'plain',
  installUrl: 'https://github.com/QwenLM/qwen-code',
  providerType: 'cli',
  applicability: 'adapted',
  systemPromptStrategy: 'stdin-prepend',
  // Mode-aware permissions (Gemini-fork flags). `plan` is read-only; `apply`/
  // `apply-yolo` auto-approve (`--yolo`) since a non-interactive run has no TTY
  // to answer per-action approval prompts.
  buildExtraArgs: (opts: AgentExtraArgsOptions): string[] => {
    const mode = opts.capabilities?.mode ?? 'apply';
    if (mode === 'plan') {
      return ['--approval-mode', 'plan'];
    }
    return ['--yolo'];
  },
};
