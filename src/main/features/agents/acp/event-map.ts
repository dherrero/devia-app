import type { AgentEvent } from '../../../../shared/domain/agent-event';

export interface EventMapState {
  textBuffer: string;
  firstTokenSent: boolean;
  readonly startedAt: number;
}

export function createEventMapState(now: number = Date.now()): EventMapState {
  return { textBuffer: '', firstTokenSent: false, startedAt: now };
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

export function mapSessionUpdate(update: unknown, state: EventMapState, now: number = Date.now()): AgentEvent[] {
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
