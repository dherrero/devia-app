import type { AgentEvent } from '../../../../shared/domain/agent-event';
import type { AcpAgentProfile, AcpToolCallLike } from './profile';

const MAX_TOOL_RESULT_CHARS = 10_000;

export interface EventMapContext {
  readonly profile: AcpAgentProfile;
  readonly serverIds: readonly string[];
}

export interface EventMapState {
  textBuffer: string;
  firstTokenSent: boolean;
  readonly startedAt: number;
  tools: Map<string, { name: string; finished: boolean }>;
  lastPlan: string | null;
}

export function createEventMapState(now: number = Date.now()): EventMapState {
  return { textBuffer: '', firstTokenSent: false, startedAt: now, tools: new Map(), lastPlan: null };
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function textOf(update: Record<string, unknown>): string | null {
  const content = asObject(update['content']);
  if (content?.['type'] !== 'text') return null;
  const text = content['text'];
  return typeof text === 'string' && text.length > 0 ? text : null;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function toolCallOf(obj: Record<string, unknown>): AcpToolCallLike | null {
  const toolCallId = obj['toolCallId'];
  if (typeof toolCallId !== 'string' || toolCallId.length === 0) return null;
  const title = typeof obj['title'] === 'string' ? obj['title'] : null;
  const kind = typeof obj['kind'] === 'string' ? obj['kind'] : null;
  return { toolCallId, title, kind, rawInput: obj['rawInput'], _meta: obj['_meta'] };
}

function toolOutput(obj: Record<string, unknown>): string {
  const blocks = Array.isArray(obj['content']) ? obj['content'] : [];
  const texts: string[] = [];
  for (const block of blocks) {
    const inner = asObject(asObject(block)?.['content']);
    if (inner?.['type'] === 'text' && typeof inner['text'] === 'string') texts.push(inner['text']);
  }
  let out = texts.join('\n');
  if (out.length === 0 && obj['rawOutput'] !== undefined && obj['rawOutput'] !== null) {
    const raw = obj['rawOutput'];
    out = typeof raw === 'string' ? raw : (JSON.stringify(raw) ?? '');
  }
  return out.slice(0, MAX_TOOL_RESULT_CHARS);
}

function startTool(call: AcpToolCallLike, obj: Record<string, unknown>, state: EventMapState, ctx: EventMapContext): AgentEvent[] {
  if (state.tools.has(call.toolCallId)) return [];
  const name = ctx.profile.toolName(call, ctx.serverIds);
  state.tools.set(call.toolCallId, { name, finished: false });
  const input = obj['rawInput'] ?? { title: call.title ?? name };
  return [{ type: 'tool_use', id: call.toolCallId, name, input }];
}

function mapTool(obj: Record<string, unknown>, state: EventMapState, ctx: EventMapContext | undefined): AgentEvent[] {
  const call = ctx ? toolCallOf(obj) : null;
  if (!ctx || !call) return [];
  if (obj['sessionUpdate'] === 'tool_call') return startTool(call, obj, state, ctx);
  const status = obj['status'];
  if (status !== 'completed' && status !== 'failed') return [];
  const events = startTool(call, obj, state, ctx);
  const entry = state.tools.get(call.toolCallId);
  if (!entry || entry.finished) return events;
  entry.finished = true;
  events.push({ type: 'tool_result', toolUseId: call.toolCallId, content: toolOutput(obj), isError: status === 'failed' });
  return events;
}

export function mapSessionUpdate(
  update: unknown,
  state: EventMapState,
  ctx?: EventMapContext,
  now: number = Date.now(),
): AgentEvent[] {
  const obj = asObject(update);
  if (!obj) return [];
  switch (obj['sessionUpdate']) {
    case 'agent_message_chunk': {
      const text = textOf(obj);
      if (text === null) return [];
      // Some agents resend the whole text so far; a same-length repeat is a plain increment.
      const cumulative =
        state.textBuffer.length > 0 && text.length > state.textBuffer.length && text.startsWith(state.textBuffer);
      const delta = cumulative ? text.slice(state.textBuffer.length) : text;
      state.textBuffer += delta;
      const events: AgentEvent[] = [];
      if (!state.firstTokenSent) {
        state.firstTokenSent = true;
        events.push({ type: 'status', label: 'streaming', ttftMs: now - state.startedAt });
      }
      events.push({ type: 'text_delta', delta });
      return events;
    }
    case 'agent_thought_chunk': {
      const text = textOf(obj);
      return text === null ? [] : [{ type: 'thinking_delta', delta: text }];
    }
    case 'tool_call':
    case 'tool_call_update':
      return mapTool(obj, state, ctx);
    case 'plan': {
      const entries = Array.isArray(obj['entries']) ? obj['entries'] : [];
      const signature = JSON.stringify(entries);
      if (signature === state.lastPlan) return [];
      state.lastPlan = signature;
      return [{ type: 'status', label: `plan: ${entries.length} steps` }];
    }
    default:
      return [];
  }
}

export function mapStopReason(stopReason: unknown): string {
  switch (stopReason) {
    case 'cancelled':
    case 'max_tokens':
    case 'max_turn_requests':
    case 'refusal':
      return stopReason;
    default:
      return 'completed';
  }
}

export function mapPromptUsage(response: unknown): AgentEvent | null {
  const usage = asObject(asObject(response)?.['usage']);
  if (!usage) return null;
  const inputTokens = num(usage['inputTokens']);
  const outputTokens = num(usage['outputTokens']);
  if (inputTokens === undefined && outputTokens === undefined) return null;
  const cached = num(usage['cachedReadTokens']);
  const thought = num(usage['thoughtTokens']);
  return {
    type: 'usage',
    ...(inputTokens !== undefined && { inputTokens }),
    ...(outputTokens !== undefined && { outputTokens }),
    ...(cached !== undefined && cached > 0 && { cachedInputTokens: cached }),
    ...(thought !== undefined && thought > 0 && { reasoningOutputTokens: thought }),
  };
}
