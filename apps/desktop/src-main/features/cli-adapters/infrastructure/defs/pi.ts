import type { RuntimeAgentDef } from '../../domain/runtime-agent-def';
import { DEFAULT_MODEL_OPTION } from './shared';

/**
 * The only built-in tools pi declares in plan mode — its documented read-only
 * set. pi has no permission modes, so plan mode is enforced by not declaring
 * the writers at all. `bash` must go too: with `edit`/`write` excluded, a model
 * simply writes the file with `echo >` (observed with pi 1.3.0), which Claude's
 * plan mode cannot do. `mcp__*` is required: once `--tools` is an allowlist,
 * an MCP tool no entry matches is never declared, whatever its exposure —
 * plan mode would lose Devia's kanban/memory/ui tools (and the user's MCP).
 */
const PLAN_TOOLS = ['read', 'grep', 'find', 'ls', 'mcp__*'];

/**
 * Pi adapter (pi 1.3.0 `--mode rpc` dialect over stdio — see `pi-rpc-session.ts`).
 *
 * Spawned as `pi --mode rpc [--model ...] [--thinking ...]`; the launcher hands
 * the child to the pi-rpc session driver, which sends the prompt via an RPC
 * `prompt` command and streams pi's events back. No prompt in argv.
 *
 * - **Continuity is native.** The driver reads the session id with `get_state`
 *   and emits `session_started`; the next turn passes `--session-id <id>`,
 *   which reopens that session (or creates it if it was deleted).
 * - **System prompt** goes through `--append-system-prompt <file>`
 *   (`'argv-file'`): pi accepts a path, and inlining tens of KB would break the
 *   Windows command-line limit.
 * - **MCP**: Devia's servers are NOT written to `.pi/mcp.json` — pi only reads
 *   that file in trusted projects, and session worktrees never are. The runner
 *   registers them per run through a generated extension (`-e`), the pi
 *   equivalent of Claude's `--mcp-config` (see `pi-mcp-extension.ts`).
 * - pi has no sandbox, so `extraAllowedDirs` needs no flag: every path the
 *   process can reach is already reachable.
 */
export const piAgentDef: RuntimeAgentDef = {
  id: 'pi',
  name: 'Pi',
  bin: 'pi',
  versionArgs: ['--version'],
  fallbackModels: [
    DEFAULT_MODEL_OPTION,
    { id: 'anthropic/claude-sonnet-4-5', label: 'Claude Sonnet 4.5 (anthropic)' },
    { id: 'anthropic/claude-opus-4-5', label: 'Claude Opus 4.5 (anthropic)' },
    { id: 'openai/gpt-5', label: 'GPT-5 (openai)' },
    { id: 'google/gemini-2.5-pro', label: 'Gemini 2.5 Pro (google)' },
  ],
  reasoningOptions: [
    { id: 'default', label: 'Default' },
    { id: 'off', label: 'Off' },
    { id: 'minimal', label: 'Minimal' },
    { id: 'low', label: 'Low' },
    { id: 'medium', label: 'Medium' },
    { id: 'high', label: 'High' },
    { id: 'xhigh', label: 'XHigh' },
  ],
  buildArgs: (_prompt, _imagePaths, _extraAllowedDirs, options = {}) => {
    const args = ['--mode', 'rpc'];
    if (options.model && options.model !== 'default') {
      args.push('--model', options.model);
    }
    if (options.reasoning && options.reasoning !== 'default') {
      args.push('--thinking', options.reasoning);
    }
    return args;
  },
  buildExtraArgs: (opts) =>
    opts.capabilities?.mode === 'plan' ? ['--tools', PLAN_TOOLS.join(',')] : [],
  buildResumeArgs: (agentSessionId) => ['--session-id', agentSessionId],
  streamFormat: 'pi-rpc',
  installUrl: 'https://pi.dev/',
  providerType: 'cli',
  applicability: 'direct',
  continuity: 'native',
  systemPromptStrategy: 'argv-file',
  buildSystemPromptFileArgs: (file) => ['--append-system-prompt', file],
};
