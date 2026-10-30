import type { AgentExtraArgsOptions, RuntimeAgentDef } from '../../domain/runtime-agent-def';
import { DEFAULT_MODEL_OPTION, clampCodexReasoning } from './shared';

/**
 * Codex CLI adapter. Runs `codex exec --json` so we get a structured
 * event stream. The launcher's `codex-event-stream` parser translates
 * each event to Claude's stream-json shape before forwarding to the UI.
 */
export const codexAgentDef: RuntimeAgentDef = {
  id: 'codex',
  name: 'Codex CLI',
  bin: 'codex',
  versionArgs: ['--version'],
  fallbackModels: [
    DEFAULT_MODEL_OPTION,
    { id: 'gpt-5.5', label: 'gpt-5.5' },
    { id: 'gpt-5.4', label: 'gpt-5.4' },
    { id: 'gpt-5.4-mini', label: 'gpt-5.4-mini' },
    { id: 'gpt-5.3-codex', label: 'gpt-5.3-codex' },
    { id: 'gpt-5.1', label: 'gpt-5.1' },
    { id: 'gpt-5.1-codex-mini', label: 'gpt-5.1-codex-mini' },
    { id: 'gpt-5-codex', label: 'gpt-5-codex' },
    { id: 'gpt-5', label: 'gpt-5' },
    { id: 'o3', label: 'o3' },
    { id: 'o4-mini', label: 'o4-mini' },
  ],
  reasoningOptions: [
    { id: 'default', label: 'Default' },
    { id: 'none', label: 'None' },
    { id: 'minimal', label: 'Minimal' },
    { id: 'low', label: 'Low' },
    { id: 'medium', label: 'Medium' },
    { id: 'high', label: 'High' },
    { id: 'xhigh', label: 'XHigh' },
  ],
  envOverrideKeys: [
    'CODEX_HOME',
    'OPENAI_BASE_URL',
    'OPENAI_API_KEY',
  ],
  buildArgs: (_prompt, _imagePaths, extraAllowedDirs = [], options = {}, runtimeContext = {}) => {
    // Permission/sandbox flags are mode-aware and live in `buildExtraArgs`.
    // Session continuity: `codex exec resume <id>` re-opens the previous
    // thread (the id comes from the `thread.started` event of the prior run).
    // The resume subcommand does NOT accept `-C` / `--add-dir` — the resumed
    // session keeps the cwd it was recorded with, so both are omitted there.
    // The explicit `-` PROMPT positional is required on resume: unlike plain
    // `exec`, resume only reads stdin when `-` is passed (per its --help).
    const resume = runtimeContext.resumeSessionId;
    const args = resume
      ? ['exec', 'resume', resume, '-', '--json', '--skip-git-repo-check']
      : ['exec', '--json', '--skip-git-repo-check'];
    if (!resume) {
      if (runtimeContext.cwd) {
        args.push('-C', runtimeContext.cwd);
      }
      const dirs = (extraAllowedDirs ?? []).filter(
        (d): d is string => typeof d === 'string' && d.length > 0,
      );
      for (const d of dirs) {
        args.push('--add-dir', d);
      }
    }
    if (options.model && options.model !== 'default') {
      args.push('--model', options.model);
    }
    if (options.reasoning && options.reasoning !== 'default') {
      const effort = clampCodexReasoning(options.model, options.reasoning);
      if (effort) {
        args.push('-c', `model_reasoning_effort="${effort}"`);
      }
    }
    return args;
  },
  promptViaStdin: true,
  streamFormat: 'json-event-stream',
  eventParser: 'codex',
  installUrl: 'https://github.com/openai/codex',
  // REV-AGENT-CORE-013: Codex exec does not expose a system-prompt CLI flag,
  // so we prepend the system header to the stdin payload.
  systemPromptStrategy: 'stdin-prepend',
  // Mode-aware permissions. `codex exec` is non-interactive by default, so the
  // real lever is `--sandbox` (an exec flag). `--ask-for-approval` is a GLOBAL
  // flag and is rejected after the `exec` subcommand, so it is not used here.
  // Windows has no Codex OS sandbox (Seatbelt/Landlock only), so `apply` falls
  // back to full access there — documented limitation, not yolo.
  // On resume (`exec resume <id>`) the `--sandbox` flag is NOT accepted, but
  // the equivalent `-c sandbox_mode=...` config override is — same policy,
  // different spelling (verified against `codex exec resume --help`).
  buildExtraArgs: (opts: AgentExtraArgsOptions): string[] => {
    const mode = opts.capabilities?.mode ?? 'apply';
    const resume = opts.resumeSessionId !== undefined;
    const sandbox = (level: string): string[] =>
      resume ? ['-c', `sandbox_mode="${level}"`] : ['--sandbox', level];
    if (mode === 'apply-yolo') {
      return ['--dangerously-bypass-approvals-and-sandbox'];
    }
    if (mode === 'plan') {
      // Codex `exec` cancels EVERY MCP tool call under a managed sandbox
      // profile (read-only AND workspace-write) — upstream regression
      // openai/codex#16685, reproduced locally on 0.136.0: only
      // danger-full-access lets the SDD planner reach devia-kanban /
      // devia-memory, which plan mode depends on. Until the fix lands,
      // plan-mode file safety rides on prompt discipline ("do NOT create or
      // modify ANY files") the same way win32 apply already rides on it.
      // TODO(codex#16685): restore sandbox('read-only') when fixed upstream.
      return sandbox('danger-full-access');
    }
    if (process.platform === 'win32') {
      return sandbox('danger-full-access');
    }
    return [...sandbox('workspace-write'), '-c', 'sandbox_workspace_write.network_access=true'];
  },
};
