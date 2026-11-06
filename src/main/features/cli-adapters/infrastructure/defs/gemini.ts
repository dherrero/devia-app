import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

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
  // Plan mode, Devia's way. Gemini's own plan mode DENIES every tool that is not read-only, and a Devia MCP
  // tool is not marked read-only (it writes the board, memory, the cards), so the agent could neither record a
  // design on the kanban nor ask the user anything — and it was free to call `exit_plan_mode` and go on to
  // write files. A per-run policy allows Devia's own servers in plan mode and keeps the agent inside it.
  buildRunFiles: ({ mode, deviaDir, runId }) => {
    if (mode !== 'plan') return null;
    const file = path.join(deviaDir, 'tmp', `gemini-plan-policy-${runId}-${crypto.randomUUID().slice(0, 8)}.toml`);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, GEMINI_PLAN_POLICY, { encoding: 'utf8', mode: 0o600 });
    } catch (err) {
      console.warn('[cli-adapters:gemini] could not write the plan-mode policy:', err instanceof Error ? err.message : String(err));
      return null;
    }
    return { args: ['--policy', file], cleanup: () => { try { fs.unlinkSync(file); } catch { /* already gone */ } } };
  },
};

/** Devia's own MCP servers, as Gemini names them (`mcpName`). */
const DEVIA_MCP_SERVERS = ['devia-kanban', 'devia-memory', 'devia-ui'] as const;

export const GEMINI_PLAN_POLICY = [
  '# Devia plan mode (generated for one run). Gemini\'s plan mode denies every tool that is not read-only;',
  '# Devia\'s own servers are how a plan is recorded and approved, so they are allowed there, and the agent',
  '# may not leave plan mode by itself: the user\'s approval card does that.',
  '',
  ...DEVIA_MCP_SERVERS.flatMap((server) => [
    '[[rule]]',
    `mcpName = "${server}"`,
    'toolName = "*"',
    'decision = "allow"',
    'priority = 900',
    'modes = ["plan"]',
    '',
  ]),
  '[[rule]]',
  'toolName = "exit_plan_mode"',
  'decision = "deny"',
  'priority = 900',
  'modes = ["plan"]',
  'denyMessage = "In Devia, plan mode ends when the user approves the plan with the plan card. Do not leave it yourself."',
  '',
].join('\n');
