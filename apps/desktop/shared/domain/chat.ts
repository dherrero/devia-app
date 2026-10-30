import type { DiffFile } from './git';
import type { CancelReason, ErrorClassification } from './agent-event';
import type { RunId } from './agent';
import type { PersistedAgentEvent } from './persisted-agent-event';
import type { RunMode } from './run-capabilities';

/**
 * Shared ChatMessage domain model.
 *
 * Defined in shared/domain so it can be imported by both the main-process
 * persistence layer (src-main) and the Angular renderer without creating
 * circular dependencies. This file must have NO imports from Angular or
 * Electron — it is pure TypeScript.
 *
 * All enrichment fields added in TS-CLI-07 are optional to maintain
 * backward compatibility with persisted sessions that predate this schema.
 */

export type MessageRole = 'user' | 'assistant' | 'system' | 'outbox';

/**
 * A single ordered content block within an assistant message.
 * Preserves the interleaved order of text segments and tool calls so the
 * bubble can render them correctly (text before Bash, Bash card, text after).
 */
export type ContentBlock =
  | { kind: 'text'; text: string }
  | { kind: 'tool_ref'; toolCallId: string };

export type RunStatus = 'running' | 'succeeded' | 'failed' | 'canceled';

export interface ToolCallRecord {
  id: string;
  name: string;
  input?: unknown;
  result?: string;
  isError?: boolean;
  /** Diff snapshot attached after a file-editing tool result (TS-CLI-10). */
  diff?: DiffFile[];
}

export interface MessageUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  reasoningOutputTokens?: number;
  costUsd?: number;
  durationMs?: number;
  /**
   * Effective context window (in tokens) the CLI is actually using for this
   * run. The same model can ship with different windows depending on flags
   * (e.g. Claude Opus 4.7 reports 200k by default but 1M with the extended
   * context flag). When present, this number takes precedence over the
   * static `MODEL_CONTEXT_LENGTH` table in `shared/domain/context-budget.ts`
   * so the statusbar's context bar reflects the real ceiling the CLI sees.
   */
  contextWindow?: number;
}

export interface ChatMessage {
  id: string;
  role: MessageRole;
  text?: string;
  /** True while the agent is actively streaming text for this message. */
  streaming?: boolean;

  // ── TS-CLI-07 enrichment fields ───────────────────────────────────────
  /**
   * Branded UUID identifying the specific run that produced this message.
   * Added in REV-AGENT-CORE-001 — older persisted messages omit this field.
   */
  runId?: RunId;
  /** Lifecycle status of the agent run that produced this message. */
  runStatus?: RunStatus;
  /**
   * Structured cancellation cause when `runStatus === 'canceled'`
   * (REV-AGENT-CORE-011). Lets the renderer render a tailored system message
   * and decide whether to show the Retry button.
   */
  cancelReason?: CancelReason;
  /** Unix timestamp (ms) when the run started. */
  startedAt?: number;
  /** Unix timestamp (ms) when the run ended (succeeded, failed, or canceled). */
  endedAt?: number;
  /** The CLI adapter id that was active when this message was produced. */
  agentId?: string;
  /** The model name reported by the agent via the `status` event. */
  model?: string;
  /**
   * Run mode in effect when this message was produced (REV-AGENT-CORE-006).
   * Rendered as a small badge on the assistant bubble. Optional — messages
   * persisted before the mode signal existed default to absent.
   */
  mode?: RunMode;
  /** Structured tool call records — replaces the legacy `tools: string[]`. */
  toolCalls?: ToolCallRecord[];
  /**
   * Ordered sequence of text segments and tool-call references.
   * When present, the bubble renders this array in order so text that appears
   * before a tool call is shown above the card, and text after appears below.
   * Falls back to `text` + `toolCalls` rendering when absent (old messages).
   */
  contentBlocks?: ContentBlock[];
  /** Accumulated thinking-block content (collapsed in the UI by default). */
  thinking?: string;
  /** Per-turn token usage and cost reported by the agent. */
  usage?: MessageUsage;
  /**
   * Ordered persisted event log (REV-AGENT-CORE-002). Preserves the original
   * ordering of text, thinking, and tool events. When present, loaders rebuild
   * the compacted fields (`text`, `thinking`, `toolCalls`, `contentBlocks`)
   * from this array. Absent on messages persisted before this contract existed.
   */
  events?: PersistedAgentEvent[];

  /**
   * Structured error classification for error system messages (TS-CLI-11).
   * Present on role=system messages that represent a failed run, so the UI
   * can render a "Retry" button and guidance without parsing the text string.
   */
  errorClassification?: ErrorClassification;

  /**
   * Cross-agent handoff metadata (S-2 F3.1). Present (with `kind: 'handoff'`)
   * on the divider message persisted when a different agent continues this
   * session; the handoff summary travels in `text` so existing persistence
   * and rehydration need no special casing.
   */
  handoff?: { fromAgentId: string; toAgentId: string };

  /**
   * Step list published by `devia_todo` (S-25 F2.1b). Present with
   * `kind: 'todo'`. Exactly ONE of these exists per session and it is UPSERTED
   * in place — the tool sends the complete list every time, so appending one
   * message per call would bury the thread in near-identical copies.
   *
   * A readable rendering also lands in `text`, so persistence, rehydration and
   * any consumer that only knows about text keep working untouched.
   */
  todo?: import('./ui-tools').TodoItem[];

  /**
   * A plan the user approved or rejected through `devia_plan_approve` (S-28
   * T-337). Present with `kind: 'plan'`; appended once per decision, never
   * upserted — a rejected plan followed by an approved one is the history.
   */
  plan?: import('./ui-tools').PlanRecord;

  // ── Legacy fields (kept for backward compatibility) ───────────────────
  /** @deprecated Use toolCalls[].name instead. Kept for old persisted sessions. */
  tools?: string[];
  /** Outbox-specific: file name. */
  name?: string;
  /** Outbox-specific: file type — plus 'handoff' for the S-2 divider message. */
  kind?: 'image' | 'video' | 'file' | 'handoff' | 'todo' | 'plan';
  /** Outbox-specific: absolute file path. */
  path?: string;
  /**
   * Outbox-specific: the remote channel the file was sent to (S-32). Present
   * when the agent delivered it with `devia_send_file`; absent for files that
   * only landed in the outbox folder.
   */
  channel?: OutboxChannel;
}

/** Remote channels an outbox file can be delivered to (S-32). */
export type OutboxChannel = 'telegram';
