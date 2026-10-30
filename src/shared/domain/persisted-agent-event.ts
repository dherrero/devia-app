/**
 * Ordered event log persisted alongside an assistant `ChatMessage`.
 *
 * Distinct from the live `AgentEvent` stream:
 *   - Coalesces `text_delta` / `thinking_delta` runs into a single
 *     `kind: 'text'` / `kind: 'thinking'` entry (preserves order, drops
 *     redundant per-token noise on disk).
 *   - Drops streaming-only metadata like `thinking_start`.
 *
 * Loaders prefer `events[]` over the compacted `contentBlocks` / `toolCalls`
 * fields. The compacted fields remain for back-compat with sessions written
 * before this contract existed.
 *
 * (REV-AGENT-CORE-002)
 */

import type { AgentEvent, ErrorClassification } from './agent-event';
import type { ToolCallRecord, ContentBlock, MessageUsage } from './chat';

export type PersistedAgentEvent =
  | { kind: 'status'; label: string; model?: string; ttftMs?: number }
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool_use'; id: string; name: string; input: unknown }
  | { kind: 'tool_result'; toolUseId: string; content: string; isError: boolean }
  | { kind: 'usage'; inputTokens?: number; outputTokens?: number; cachedInputTokens?: number; reasoningOutputTokens?: number; costUsd?: number; durationMs?: number; contextWindow?: number }
  | { kind: 'turn_end'; stopReason: string }
  | { kind: 'session_started'; agentSessionId: string }
  | { kind: 'error'; message: string; classification?: ErrorClassification }
  | { kind: 'raw'; line: string };

/**
 * Append one live `AgentEvent` to the persisted log, coalescing consecutive
 * text and thinking deltas. Pure: returns a fresh array, never mutates input.
 *
 * Rules:
 *   - `text_delta`   → if the last entry is `kind: 'text'`, concatenate.
 *                      Otherwise push a new `kind: 'text'` entry.
 *   - `thinking_delta`→ same as text_delta but with `kind: 'thinking'`.
 *   - `thinking_start`→ dropped (it is structural, not content).
 *   - everything else→ mapped 1:1 from `AgentEvent.type` to `PersistedAgentEvent.kind`.
 */
export function appendAgentEvent(
  events: readonly PersistedAgentEvent[],
  event: AgentEvent,
): PersistedAgentEvent[] {
  switch (event.type) {
    case 'text_delta': {
      const last = events[events.length - 1];
      if (last?.kind === 'text') {
        return [...events.slice(0, -1), { kind: 'text', text: last.text + event.delta }];
      }
      return [...events, { kind: 'text', text: event.delta }];
    }
    case 'thinking_delta': {
      const last = events[events.length - 1];
      if (last?.kind === 'thinking') {
        return [...events.slice(0, -1), { kind: 'thinking', text: last.text + event.delta }];
      }
      return [...events, { kind: 'thinking', text: event.delta }];
    }
    case 'thinking_start':
      // Structural marker only — the next thinking_delta will create the entry.
      return events.slice();
    case 'status':
      return [...events, { kind: 'status', label: event.label, ...(event.model !== undefined && { model: event.model }), ...(event.ttftMs !== undefined && { ttftMs: event.ttftMs }) }];
    case 'tool_use':
      return [...events, { kind: 'tool_use', id: event.id, name: event.name, input: event.input }];
    case 'tool_result':
      return [...events, { kind: 'tool_result', toolUseId: event.toolUseId, content: event.content, isError: event.isError }];
    case 'usage':
      return [...events, {
        kind: 'usage',
        ...(event.inputTokens !== undefined && { inputTokens: event.inputTokens }),
        ...(event.outputTokens !== undefined && { outputTokens: event.outputTokens }),
        ...(event.cachedInputTokens !== undefined && { cachedInputTokens: event.cachedInputTokens }),
        ...(event.reasoningOutputTokens !== undefined && { reasoningOutputTokens: event.reasoningOutputTokens }),
        ...(event.costUsd !== undefined && { costUsd: event.costUsd }),
        ...(event.durationMs !== undefined && { durationMs: event.durationMs }),
        ...(event.contextWindow !== undefined && { contextWindow: event.contextWindow }),
      }];
    case 'turn_end':
      return [...events, { kind: 'turn_end', stopReason: event.stopReason }];
    case 'session_started':
      return [...events, { kind: 'session_started', agentSessionId: event.agentSessionId }];
    case 'error':
      return [...events, { kind: 'error', message: event.message, ...(event.classification !== undefined && { classification: event.classification }) }];
    case 'raw':
      return [...events, { kind: 'raw', line: event.line }];
    case 'context_compacted':
      // E-DSK-13 Fase D: a runtime-only signal — the runner reacts by re-injecting
      // memory on the next run. Nothing to persist in the chat transcript.
      return events.slice();
    case 'rate_limit':
      // Runtime-only: the runner schedules the automatic resume. The limit
      // message itself already reaches the transcript as the agent's text.
      return events.slice();
    default: {
      // Exhaustive helper — unknown future event types are silently dropped
      // from the persisted log (they still flow through the live stream).
      const _exhaustive: never = event;
      void _exhaustive;
      return events.slice();
    }
  }
}

/**
 * Result of rebuilding the compacted message fields from an `events[]` array.
 * The loader merges this onto the persisted `ChatMessage` so the bubble can
 * render uniformly regardless of whether the message was loaded from disk or
 * built live.
 */
export interface RebuiltMessageShape {
  text: string;
  thinking: string;
  toolCalls: ToolCallRecord[];
  contentBlocks: ContentBlock[];
  usage?: MessageUsage;
  agentSessionId?: string;
}

/**
 * Rebuild the compacted `ChatMessage` fields from a persisted event log.
 * Pure. Tolerates a malformed/empty array by returning empty defaults.
 *
 * - `text` = concatenation of every `kind:'text'` entry (turn-by-turn).
 * - `thinking` = concatenation of every `kind:'thinking'` entry.
 * - `toolCalls` = one record per `tool_use`, merged with matching `tool_result`.
 * - `contentBlocks` = ordered interleaving of `kind:'text'` blocks and
 *   `kind:'tool_use'` references — mirrors the live render order.
 * - `usage` = the *last* `usage` entry observed (per-turn snapshot).
 * - `agentSessionId` = the last `session_started` payload, if any.
 */
export function rebuildFromEvents(events: readonly PersistedAgentEvent[]): RebuiltMessageShape {
  let text = '';
  let thinking = '';
  const toolCalls: ToolCallRecord[] = [];
  const contentBlocks: ContentBlock[] = [];
  let usage: MessageUsage | undefined;
  let agentSessionId: string | undefined;

  for (const ev of events) {
    switch (ev.kind) {
      case 'text':
        text += ev.text;
        contentBlocks.push({ kind: 'text', text: ev.text });
        break;
      case 'thinking':
        thinking += ev.text;
        break;
      case 'tool_use': {
        toolCalls.push({ id: ev.id, name: ev.name, input: ev.input });
        contentBlocks.push({ kind: 'tool_ref', toolCallId: ev.id });
        break;
      }
      case 'tool_result': {
        const target = toolCalls.find(tc => tc.id === ev.toolUseId);
        if (target) {
          target.result = ev.content;
          target.isError = ev.isError;
        }
        break;
      }
      case 'usage': {
        // Merge, mirroring the live stream: the run-end event carries cost +
        // window but not always tokens, and replacing would drop the context
        // size every rehydrated message needs for the footer bar.
        const u: MessageUsage = { ...(usage ?? {}) };
        if (ev.inputTokens !== undefined) u.inputTokens = ev.inputTokens;
        if (ev.outputTokens !== undefined) u.outputTokens = ev.outputTokens;
        if (ev.cachedInputTokens !== undefined) u.cachedInputTokens = ev.cachedInputTokens;
        if (ev.reasoningOutputTokens !== undefined) u.reasoningOutputTokens = ev.reasoningOutputTokens;
        if (ev.costUsd !== undefined) u.costUsd = ev.costUsd;
        if (ev.durationMs !== undefined) u.durationMs = ev.durationMs;
        if (ev.contextWindow !== undefined) u.contextWindow = ev.contextWindow;
        usage = u;
        break;
      }
      case 'session_started':
        agentSessionId = ev.agentSessionId;
        break;
      // status / turn_end / error / raw — not used to rebuild compacted shape.
      case 'status':
      case 'turn_end':
      case 'error':
      case 'raw':
        break;
    }
  }

  const result: RebuiltMessageShape = { text, thinking, toolCalls, contentBlocks };
  if (usage !== undefined) result.usage = usage;
  if (agentSessionId !== undefined) result.agentSessionId = agentSessionId;
  return result;
}

/**
 * Validate that an arbitrary value is a well-formed `PersistedAgentEvent[]`.
 * Used by the loader to gracefully degrade to the compacted shape when a
 * session file has been tampered with or written by a future version.
 */
export function isValidEventLog(value: unknown): value is PersistedAgentEvent[] {
  if (!Array.isArray(value)) return false;
  const validKinds = new Set([
    'status', 'text', 'thinking', 'tool_use', 'tool_result',
    'usage', 'turn_end', 'session_started', 'error', 'raw',
  ]);
  return value.every(ev =>
    ev !== null && typeof ev === 'object' && 'kind' in ev &&
    typeof (ev as { kind: unknown }).kind === 'string' &&
    validKinds.has((ev as { kind: string }).kind),
  );
}
