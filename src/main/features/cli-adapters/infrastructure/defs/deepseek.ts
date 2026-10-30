import type { RuntimeAgentDef } from '../../domain/runtime-agent-def';
import { DEFAULT_MODEL_OPTION } from './shared';

/**
 * DeepSeek adapter — drives DeepSeek-TUI (a.k.a. CodeWhale after the rename),
 * a Codex-style facade for DeepSeek models. The `deepseek` dispatcher owns the
 * `exec` subcommand (`codewhale` is the post-rename alias, kept as a fallback
 * bin). `exec` takes the prompt as a required positional argv — there is no
 * stdin sentinel — so `promptViaStdin` is false and the launcher places the
 * composed prompt into argv. `--auto` enables agentic mode with auto-approval
 * (the run is non-interactive, so an approval prompt would hang it). Output is
 * plain text on stdout (tool calls go to stderr); `--json` would batch deltas
 * into a single trailing object, so we keep plain streaming.
 *
 * No system-prompt flag and stdin is ignored, so the Devia system prompt
 * cannot be delivered (`systemPromptStrategy: 'unsupported'`). DeepSeek-TUI is a
 * third-party CLI; permission modes are not wired (it always runs `--auto`).
 */
export const deepseekAgentDef: RuntimeAgentDef = {
  id: 'deepseek',
  name: 'DeepSeek TUI',
  bin: 'deepseek',
  fallbackBins: ['codewhale'],
  versionArgs: ['--version'],
  fallbackModels: [
    DEFAULT_MODEL_OPTION,
    { id: 'deepseek-v4-pro', label: 'deepseek-v4-pro' },
    { id: 'deepseek-v4-flash', label: 'deepseek-v4-flash' },
  ],
  envOverrideKeys: [
    'DEEPSEEK_API_KEY',
    'DEEPSEEK_BASE_URL',
  ],
  buildArgs: (prompt, _imagePaths, _extra, options = {}) => {
    const args = ['exec', '--auto'];
    if (options.model && options.model !== 'default') {
      args.push('--model', options.model);
    }
    args.push(prompt);
    return args;
  },
  // exec ships the prompt as argv; guard the OS command-line length limit.
  maxPromptArgBytes: 30_000,
  streamFormat: 'plain',
  installUrl: 'https://github.com/Hmbown/DeepSeek-TUI',
  providerType: 'cli',
  applicability: 'adapted',
  systemPromptStrategy: 'unsupported',
};
