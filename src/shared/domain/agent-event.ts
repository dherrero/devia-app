/**
 * Contract A (render ↔ core, S-30): the canonical events every agent's mapper
 * emits, whatever its CLI. The renderer and the core consume ONLY these — no
 * consumer may depend on which agent produced them.
 *
 * Defined in shared/domain so it is importable by both the main process and
 * the Angular renderer. IPC wire format: one JSON.stringify(AgentEvent) string
 * per event, over the `claude:output` channel (name kept for compatibility).
 *
 * Semantics every mapper must honour:
 *   - `session_started` — the agent's NATIVE session id, emitted once per run;
 *     the next turn resumes with it. Never emitted by an agent without native
 *     resume.
 *   - `tool_use.name` — built-ins in the agent's own vocabulary (Bash, bash,
 *     read…); MCP tools ALWAYS as `mcp__<serverId>__<tool>` with the REAL
 *     server id (`devia-ui`, `e2e-echo`). A CLI that mangles it (pi sanitises
 *     to `devia_ui`, OpenCode emits `devia-ui_devia_todo`) is normalised by its
 *     mapper — icons, cards and the audit log key on this form.
 *   - `usage` — tokens of the LAST request (`inputTokens` excludes cache,
 *     `cachedInputTokens` is every cache bucket, so their sum is the context
 *     fill); `costUsd` is the run's cost SO FAR (the renderer keeps the last
 *     event, it never sums them); `contextWindow` of the run's own model.
 *   - `turn_end` — exactly once, when the agent will not continue on its own
 *     (pi: `agent_settled`, not `agent_end`).
 *   - `context_compacted` — the agent dropped older context; Devia re-injects
 *     its memory on the next run.
 */

export type ErrorClassification =
  | 'transient'
  | 'auth'
  | 'prompt-too-large'
  | 'crash'
  | 'unknown';

/**
 * Distinguishes the cause of a deliberate run termination (REV-AGENT-CORE-011).
 * `undefined` means the run ended naturally or crashed.
 *
 *   user             — the user clicked Stop / Cancel.
 *   idle             — the launcher's 5-minute inactivity watchdog fired.
 *   question_timeout — an AskUserQuestion went unanswered past its timeout.
 */
export type CancelReason = 'user' | 'idle' | 'question_timeout';

export type AgentEvent =
  | { type: 'status'; label: string; model?: string; ttftMs?: number }
  | { type: 'text_delta'; delta: string }
  | { type: 'thinking_delta'; delta: string }
  | { type: 'thinking_start' }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: string; isError: boolean }
  /** `inputTokens` EXCLUDES cached tokens (Anthropic's split): context fill =
   *  inputTokens + cachedInputTokens of the LAST request, never a run sum. */
  | { type: 'usage'; inputTokens?: number; outputTokens?: number; cachedInputTokens?: number; reasoningOutputTokens?: number; costUsd?: number; durationMs?: number; contextWindow?: number }
  | { type: 'turn_end'; stopReason: string }
  | { type: 'error'; message: string; classification?: ErrorClassification }
  /** Emitted once per run when the agent confirms its session ID. The use
   *  case stores it and passes it back on the next run via def.buildResumeArgs.
   *  Never emitted if the agent fails before completing its first turn. */
  | { type: 'session_started'; agentSessionId: string }
  /** The agent compacted its own context mid-session (older turns summarised
   *  away to fit the window), so anything Devia injected earlier is gone. The
   *  runner reacts by re-injecting its memory context on the next run
   *  (E-DSK-13 Fase D). Only Claude Code emits an observable signal today
   *  (system/compact_boundary); other CLIs are pending — see the
   *  `context-recovery` feature. `trigger`/`preTokens` are best-effort metadata. */
  | { type: 'context_compacted'; trigger?: 'auto' | 'manual'; preTokens?: number }
  /** The account's usage window is exhausted (`rejected`) or close to it. Only
   *  `rejected` can end a run; `resetsAt` is epoch MILLISECONDS when the agent
   *  reports when it can continue. Claude Code only today. */
  | { type: 'rate_limit'; status: 'rejected' | 'warning'; resetsAt?: number; rateLimitType?: string }
  | { type: 'raw'; line: string };

export type AgentEventSink = (event: AgentEvent) => void;
