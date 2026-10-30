import path from 'node:path';
import type { AgentExtraArgsOptions, RuntimeAgentDef } from '../../domain/runtime-agent-def';
import { DEFAULT_MODEL_OPTION } from './shared';

/**
 * Qoder CLI adapter.
 *
 * Qoder is a Claude-Code-flavoured CLI: `qodercli -p --output-format
 * stream-json` emits JSONL parsed by `qoder-event-stream.ts`, and it exposes
 * Claude-style `--permission-mode` values, so permissions are mode-aware in
 * `buildExtraArgs`. The prompt is piped via stdin; `-w` selects the workspace
 * and `--attachment` carries image inputs. Auth stays Qoder-owned (persisted
 * `qodercli login` or `QODER_PERSONAL_ACCESS_TOKEN` in the inherited env).
 */
export const qoderAgentDef: RuntimeAgentDef = {
  id: 'qoder',
  name: 'Qoder CLI',
  bin: 'qodercli',
  fallbackBins: ['qoder'],
  versionArgs: ['--version'],
  fallbackModels: [
    DEFAULT_MODEL_OPTION,
    { id: 'lite', label: 'Lite' },
    { id: 'efficient', label: 'Efficient' },
    { id: 'auto', label: 'Auto' },
    { id: 'performance', label: 'Performance' },
    { id: 'ultimate', label: 'Ultimate' },
  ],
  envOverrideKeys: [
    'QODER_API_KEY',
    'QODER_BASE_URL',
  ],
  buildArgs: (_prompt, imagePaths, extraAllowedDirs = [], options = {}, runtimeContext = {}) => {
    // `-p` is print mode (the prompt itself is piped via stdin). Permission
    // mode is mode-aware in buildExtraArgs.
    const args = ['-p', '--output-format', 'stream-json'];
    if (runtimeContext.cwd) {
      args.push('-w', runtimeContext.cwd);
    }
    if (options.model && options.model !== 'default') {
      args.push('--model', options.model);
    }
    const dirs = (extraAllowedDirs ?? []).filter(
      (d): d is string => typeof d === 'string' && path.isAbsolute(d),
    );
    for (const d of dirs) args.push('--add-dir', d);
    const attachments = (imagePaths ?? []).filter(
      (p): p is string => typeof p === 'string' && path.isAbsolute(p),
    );
    for (const p of attachments) args.push('--attachment', p);
    return args;
  },
  supportsImagePaths: true,
  promptViaStdin: true,
  streamFormat: 'json-event-stream',
  eventParser: 'qoder',
  installUrl: 'https://qoder.com',
  docsUrl: 'https://docs.qoder.com/en/cli',
  providerType: 'cli',
  applicability: 'direct',
  // REV-AGENT-CORE-013: no system-prompt flag confirmed; prepend via stdin.
  systemPromptStrategy: 'stdin-prepend',
  // Mode-aware permissions (Claude-style `--permission-mode`). In headless `-p`
  // mode an action that would `ask` is denied, so `plan` is effectively
  // read-only and `apply` auto-accepts edits.
  buildExtraArgs: (opts: AgentExtraArgsOptions): string[] => {
    const mode = opts.capabilities?.mode ?? 'apply';
    if (mode === 'plan') {
      return ['--permission-mode', 'plan'];
    }
    if (mode === 'apply-yolo') {
      return ['--permission-mode', 'bypass_permissions'];
    }
    return ['--permission-mode', 'accept_edits'];
  },
};
