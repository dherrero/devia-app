import type { AgentEventSink, StreamParser } from '../../cli-adapters/domain/stream-parser';
import { LineBuffer } from '../../cli-adapters/infrastructure/parsers/line-buffer';
import type {
  ContentBlockDeltaEvent,
  ContentBlockStartEvent,
  MessageDeltaEvent,
  AssistantLimitLine,
  MessageStartEvent,
  RateLimitEventLine,
  RateLimitInfo,
  StreamJsonLine,
  UsageBlock,
} from './wire';
import { isLimitText, parseResetFromText } from './limit-text';

/**
 * Full-featured decoder for Claude Code's `--output-format stream-json
 * --verbose` JSONL stream.
 *
 * Claude emits two interleaved shapes:
 *
 * 1. Anthropic SDK streaming events (content_block_start/delta/stop,
 *    message_start/delta/stop). These carry incremental text, thinking
 *    blocks, tool_use input fragments, and usage counters.
 *
 * 2. Claude Code wrapper events (assistant, result). These repeat the
 *    final assembled content — we skip them to avoid double-emitting
 *    text that was already streamed via (1).
 *
 * For any line that cannot be reliably decoded we emit { type:'raw' }
 * so the renderer can at least log it without losing data.
 */

/** Sums Anthropic's two cache buckets into a single `cachedInputTokens` so the
 *  footer's context bar reflects the real on-the-wire context size. The SDK
 *  reports cache hits and cache writes separately; for context-window math
 *  what matters is the union (both occupy tokens in the prompt window). */
function totalCachedInputTokens(usage: UsageBlock | undefined): number | undefined {
  if (!usage) return undefined;
  const create = usage.cache_creation_input_tokens ?? 0;
  const read = usage.cache_read_input_tokens ?? 0;
  const total = create + read;
  return total > 0 ? total : undefined;
}

/** Claude Code's `result.usage` is the SUM of every API request in the run
 *  (an agentic turn with N tool calls re-reads the cached prefix N times), so
 *  it is a cost figure, never a context size. Only the last request's usage
 *  measures what the window holds now; `iterations` carries it when present. */
function lastRequestUsage(usage: UsageBlock | undefined): UsageBlock | undefined {
  const it = usage?.iterations;
  if (!Array.isArray(it) || it.length === 0) return undefined;
  const last = it[it.length - 1];
  return last && typeof last === 'object' ? last : undefined;
}

/** `modelUsage` lists every model the run touched — Claude Code also calls a
 *  small model (Haiku, 200k) for side tasks, so taking the first entry can
 *  report the wrong ceiling. Prefer the turn's own model, else the largest. */
function pickContextWindow(
  modelUsage: Record<string, { contextWindow?: number }>,
  model: string | undefined,
): number | undefined {
  const own = model ? modelUsage[model]?.contextWindow : undefined;
  if (typeof own === 'number' && own > 0) return own;
  let max: number | undefined;
  for (const entry of Object.values(modelUsage)) {
    const w = entry?.contextWindow;
    if (typeof w === 'number' && w > 0 && (max === undefined || w > max)) max = w;
  }
  return max;
}


// ── Parser ────────────────────────────────────────────────────────────────────

export function createClaudeStreamParser(sink: AgentEventSink): StreamParser {
  const buf = new LineBuffer();

  // Per-block state: index → meta
  const blockKind = new Map<number, 'text' | 'thinking' | 'tool_use'>();
  const toolUseId = new Map<number, string>();
  const toolUseName = new Map<number, string>();
  const toolInputBuf = new Map<number, string>();
  const emittedToolUseIds = new Set<string>();

  // Track which text we have already streamed via content_block_delta so we
  // can skip the duplicated full text in the Claude Code `assistant` wrapper.
  let streamedAnyText = false;

  // Input tokens captured from message_start so they can be included in the
  // final usage event emitted by message_delta (REV-TS-CLI-06-04).
  let storedInputTokens: number | undefined = undefined;
  // Cached input tokens (cache_creation + cache_read) captured from
  // message_start so message_delta can re-emit the complete picture without
  // having to re-read it from the SDK delta event.
  let storedCachedInputTokens: number | undefined = undefined;
  // Model of the most recent request, to pick its window out of `modelUsage`.
  let lastModel: string | undefined = undefined;
  // Without --include-partial-messages there is no message_start, so the
  // per-request usage has to come from the `assistant` wrapper instead.
  let sawMessageStart = false;
  // A `rejected` rate_limit_event was seen: the run's error `result` is the limit.
  let limitRejected = false;

  function secondsToMs(value: unknown): number | undefined {
    return typeof value === 'number' && value > 0 ? value * 1000 : undefined;
  }

  // The same rejection shows up in up to three lines of one run (event,
  // assistant message, error result): the runner needs it once.
  function reportRejected(info: RateLimitInfo | undefined, text?: string): void {
    if (limitRejected) return;
    limitRejected = true;
    const resetsAt = secondsToMs(info?.resetsAt) ?? (text !== undefined ? parseResetFromText(text, Date.now()) : undefined);
    sink({
      type: 'rate_limit',
      status: 'rejected',
      ...(resetsAt !== undefined && { resetsAt }),
      ...(typeof info?.rateLimitType === 'string' && { rateLimitType: info.rateLimitType }),
    });
  }

  function handleLine(line: string): void {
    let raw: StreamJsonLine;
    try {
      raw = JSON.parse(line) as StreamJsonLine;
    } catch {
      sink({ type: 'raw', line });
      return;
    }

    // Claude Code wraps Anthropic SDK events inside `{ type: 'stream_event',
    // event: { ... real SDK event ... }, session_id, parent_tool_use_id, uuid }`
    // when partial messages are enabled. Unwrap once so the message_start /
    // content_block_* / message_delta handlers below see the original SDK
    // shape — otherwise `model`, `inputTokens` and the per-turn `outputTokens`
    // are silently dropped (the wrapper type matches no case).
    if (raw.type === 'stream_event' && raw['event'] && typeof raw['event'] === 'object') {
      raw = raw['event'] as StreamJsonLine;
    }

    const evType = typeof raw.type === 'string' ? raw.type : '';

    // ── message_start ──────────────────────────────────────────────────────
    if (evType === 'message_start') {
      const ev = raw as unknown as MessageStartEvent;
      const model = ev.message?.model ?? undefined;
      if (model) lastModel = model;
      sawMessageStart = true;
      sink({ type: 'status', label: 'streaming', model });
      // Emit input + cached-input token count from message_start.usage
      // (REV-TS-CLI-06-04). The cached half is the union of cache_creation
      // and cache_read — both occupy tokens in the model's context window,
      // so the footer's context bar needs the sum to be accurate.
      const inputTokens = ev.message?.usage?.input_tokens;
      const cachedInputTokens = totalCachedInputTokens(ev.message?.usage);
      storedInputTokens = typeof inputTokens === 'number' ? inputTokens : undefined;
      storedCachedInputTokens = cachedInputTokens;
      if (storedInputTokens !== undefined || storedCachedInputTokens !== undefined) {
        sink({
          type: 'usage',
          ...(storedInputTokens !== undefined && { inputTokens: storedInputTokens }),
          ...(storedCachedInputTokens !== undefined && { cachedInputTokens: storedCachedInputTokens }),
        });
      }
      // Reset per-turn state for multi-turn streaming sessions.
      streamedAnyText = false;
      blockKind.clear();
      toolUseId.clear();
      toolUseName.clear();
      toolInputBuf.clear();
      emittedToolUseIds.clear();
      return;
    }

    // ── content_block_start ────────────────────────────────────────────────
    if (evType === 'content_block_start') {
      const ev = raw as unknown as ContentBlockStartEvent;
      const cb = ev.content_block;
      if (!cb) return;

      if (cb.type === 'text') {
        blockKind.set(ev.index, 'text');
      } else if (cb.type === 'thinking') {
        blockKind.set(ev.index, 'thinking');
        sink({ type: 'thinking_start' });
      } else if (cb.type === 'tool_use') {
        blockKind.set(ev.index, 'tool_use');
        toolUseId.set(ev.index, cb.id);
        toolUseName.set(ev.index, cb.name);
        toolInputBuf.set(ev.index, '');
      }
      return;
    }

    // ── content_block_delta ────────────────────────────────────────────────
    if (evType === 'content_block_delta') {
      const ev = raw as unknown as ContentBlockDeltaEvent;
      const delta = ev.delta;
      if (!delta) return;

      if (delta.type === 'text_delta' && delta.text) {
        streamedAnyText = true;
        sink({ type: 'text_delta', delta: delta.text });
      } else if (delta.type === 'thinking_delta' && delta.thinking) {
        sink({ type: 'thinking_delta', delta: delta.thinking });
      } else if (delta.type === 'input_json_delta') {
        const prev = toolInputBuf.get(ev.index) ?? '';
        toolInputBuf.set(ev.index, prev + (delta.partial_json ?? ''));
      }
      return;
    }

    // ── content_block_stop ─────────────────────────────────────────────────
    if (evType === 'content_block_stop') {
      const index = typeof raw['index'] === 'number' ? raw['index'] : -1;
      if (blockKind.get(index) === 'tool_use') {
        const id = toolUseId.get(index) ?? `tool-${index}`;
        const name = toolUseName.get(index) ?? 'unknown';
        const jsonStr = toolInputBuf.get(index) ?? '';
        let input: unknown = {};
        try { input = jsonStr ? (JSON.parse(jsonStr) as unknown) : {}; } catch { input = { _raw: jsonStr }; }
        if (!emittedToolUseIds.has(id)) {
          emittedToolUseIds.add(id);
          sink({ type: 'tool_use', id, name, input });
        }
        blockKind.delete(index);
        toolUseId.delete(index);
        toolUseName.delete(index);
        toolInputBuf.delete(index);
      }
      return;
    }

    // ── message_delta ──────────────────────────────────────────────────────
    if (evType === 'message_delta') {
      const ev = raw as unknown as MessageDeltaEvent;
      const stopReason = ev.delta?.stop_reason ?? 'end_turn';
      const outputTokens = ev.usage?.output_tokens;
      // message_delta sometimes carries an updated cache snapshot; prefer it
      // over the one stored at message_start when present.
      const deltaCached = totalCachedInputTokens(ev.usage);
      const cachedInputTokens = deltaCached ?? storedCachedInputTokens;
      sink({ type: 'turn_end', stopReason });
      if (outputTokens !== undefined) {
        // Include inputTokens + cachedInputTokens stored from message_start
        // so the final usage event carries the complete token picture
        // (REV-TS-CLI-06-04). The renderer uses both to compute context %.
        sink({
          type: 'usage',
          outputTokens,
          ...(storedInputTokens !== undefined && { inputTokens: storedInputTokens }),
          ...(cachedInputTokens !== undefined && { cachedInputTokens }),
        });
      }
      return;
    }

    // ── message_stop ───────────────────────────────────────────────────────
    if (evType === 'message_stop') {
      // No additional action needed; turn_end was already emitted.
      return;
    }

    // ── Claude Code wrapper: assistant ─────────────────────────────────────
    if (evType === 'assistant') {
      // A hit limit arrives as a synthetic assistant message ("You've hit your
      // session limit · resets 11:30am (Europe/Madrid)") flagged `error` /
      // `apiError`, with the structured window under `apiErrorParams`.
      const limitMsg = raw as unknown as AssistantLimitLine;
      const limitText = limitMsg.message?.content?.find((b) => b?.type === 'text')?.text;
      if (
        limitMsg.apiError === 'usage_limit_reached' ||
        (limitMsg.error === 'rate_limit' && typeof limitText === 'string' && isLimitText(limitText))
      ) {
        reportRejected(limitMsg.apiErrorParams?.rate_limit_info ?? limitMsg.quotaLimits, limitText);
      }
      // The wrapper always carries `message.model`. Emit it as a fallback
      // status for builds / future versions where message_start is missing
      // or already-skipped — without this, the footer's model label stays
      // empty even when the run completes successfully.
      const message = (raw as { message?: { model?: unknown; content?: unknown[] } }).message;
      const wrapperModel = typeof message?.model === 'string' ? message.model : undefined;
      if (wrapperModel) {
        lastModel = wrapperModel;
        sink({ type: 'status', label: 'streaming', model: wrapperModel });
      }
      if (!sawMessageStart) {
        const usage = (message as { usage?: UsageBlock } | undefined)?.usage;
        const inputTokens = usage?.input_tokens;
        const cachedInputTokens = totalCachedInputTokens(usage);
        if (typeof inputTokens === 'number' || cachedInputTokens !== undefined) {
          sink({
            type: 'usage',
            ...(typeof inputTokens === 'number' && { inputTokens }),
            ...(cachedInputTokens !== undefined && { cachedInputTokens }),
          });
        }
      }

      // Skip the content fallback if we already streamed text via
      // content_block_delta to avoid duplicating the full assistant text.
      if (streamedAnyText) return;
      // Fallback: emit text from the wrapper for older Claude Code builds
      // that don't stream content_block_delta events.
      const content = message?.content;
      if (!Array.isArray(content)) return;
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        const b = block as { type?: string; text?: string; name?: string; id?: string; input?: unknown };
        if (b.type === 'text' && b.text) {
          sink({ type: 'text_delta', delta: b.text });
        } else if (b.type === 'tool_use' && b.name) {
          const id = b.id ?? `tool-fallback`;
          if (emittedToolUseIds.has(id)) continue;
          emittedToolUseIds.add(id);
          sink({
            type: 'tool_use',
            id,
            name: b.name,
            input: b.input ?? {},
          });
        }
      }
      return;
    }

    // ── Claude Code wrapper: result ────────────────────────────────────────
    if (evType === 'result') {
      // Capture the agent-generated session ID so the use case can persist it
      // and pass --resume on the next call. Idempotent re-emit: the same id was
      // already captured from `system`/`init` below — this covers builds that
      // ever omit the init line, never changing the id mid-run.
      if (typeof raw['session_id'] === 'string' && raw['session_id'].length > 0) {
        sink({ type: 'session_started', agentSessionId: raw['session_id'] as string });
      }
      const isError = raw['is_error'];
      if (isError === true) {
        const msg = typeof raw['result'] === 'string' ? raw['result'] : 'Unknown error';
        // Last resort when neither the event nor the assistant message came through.
        if (!limitRejected && isLimitText(msg)) reportRejected(undefined, msg);
        // A hit limit is not an unknown failure: waiting fixes it.
        sink({ type: 'error', message: msg, classification: limitRejected ? 'transient' : 'unknown' });
      }
      // T-6: surface the wrapper's total_cost_usd + duration_ms so the footer's
      // cost block can render. Context tokens come ONLY from the last request
      // in `usage.iterations` — the top-level counters are run-cumulative.
      const costUsd = typeof raw['total_cost_usd'] === 'number' ? raw['total_cost_usd'] : undefined;
      const durationMs = typeof raw['duration_ms'] === 'number' ? raw['duration_ms'] : undefined;
      const lastUsage = lastRequestUsage(
        raw['usage'] && typeof raw['usage'] === 'object' ? (raw['usage'] as UsageBlock) : undefined,
      );
      const resultCached = totalCachedInputTokens(lastUsage);
      const resultInput = typeof lastUsage?.input_tokens === 'number'
        ? lastUsage.input_tokens
        : undefined;
      // Claude Code reports the *effective* context window per model under
      // `modelUsage.<model>.contextWindow` — Opus 4.7 ships with 200k by
      // default and 1M with the extended flag, so the static table can be
      // off by 5×. Forward it so the renderer's context bar reflects the
      // real ceiling instead of guessing from the model id.
      const modelUsage = raw['modelUsage'] && typeof raw['modelUsage'] === 'object'
        ? (raw['modelUsage'] as Record<string, { contextWindow?: number }>)
        : undefined;
      const contextWindow = modelUsage ? pickContextWindow(modelUsage, lastModel) : undefined;
      if (costUsd !== undefined || durationMs !== undefined || resultCached !== undefined || resultInput !== undefined || contextWindow !== undefined) {
        sink({
          type: 'usage',
          ...(resultInput !== undefined && { inputTokens: resultInput }),
          ...(resultCached !== undefined && { cachedInputTokens: resultCached }),
          ...(costUsd !== undefined ? { costUsd } : {}),
          ...(durationMs !== undefined ? { durationMs } : {}),
          ...(contextWindow !== undefined && { contextWindow }),
        });
      }
      // `result` is the definitive end-of-run signal from Claude Code. Emit
      // turn_end here so the launcher closes stdin even when Claude Code is
      // not streaming Anthropic SDK events (no --include-partial-messages).
      // If message_delta already fired turn_end earlier this is a safe no-op:
      // closeStdin() is idempotent and turn_end has no renderer side-effect.
      sink({ type: 'turn_end', stopReason: 'end_turn' });
      return;
    }

    // ── Claude Code wrapper: rate_limit_event ──────────────────────────────
    if (evType === 'rate_limit_event') {
      const info = (raw as unknown as RateLimitEventLine).rate_limit_info;
      // `allowed` is the steady state and arrives every run: not worth an event.
      if (info?.status === 'rejected') reportRejected(info);
      else if (info?.status === 'allowed_warning') {
        const resetsAt = secondsToMs(info.resetsAt);
        sink({
          type: 'rate_limit',
          status: 'warning',
          ...(resetsAt !== undefined && { resetsAt }),
          ...(typeof info.rateLimitType === 'string' && { rateLimitType: info.rateLimitType }),
        });
      }
      return;
    }

    // ── system / user / other Claude Code envelope types ───────────────────
    if (evType === 'system') {
      // Capture the native session id from the FIRST stream line (`system`/`init`
      // carries it), not only from the terminal `result`. A run that never
      // reaches `result` — cancelled, killed on AskUserQuestion timeout, or
      // crashed — must still leave its session resumable via `--resume <id>`,
      // otherwise the next turn starts a fresh session with no context (T-194).
      // Idempotent: the id is stable for the whole run, so re-emitting it from
      // a later `result` is a harmless no-op.
      if (typeof raw['session_id'] === 'string' && raw['session_id'].length > 0) {
        sink({ type: 'session_started', agentSessionId: raw['session_id'] as string });
      }
      // Claude Code marks an in-session context compaction with a dedicated
      // system subtype. Surface it so the runner can re-inject Devia's memory
      // on the next run (E-DSK-13 Fase D) — the older turns, and any memory we
      // injected into them, were just summarised away to fit the window.
      if (raw['subtype'] === 'compact_boundary') {
        const meta = raw['compact_metadata'];
        const m = meta && typeof meta === 'object' ? (meta as Record<string, unknown>) : undefined;
        const trigger = m?.['trigger'];
        const preTokens = m?.['pre_tokens'];
        sink({
          type: 'context_compacted',
          ...(trigger === 'auto' || trigger === 'manual' ? { trigger } : {}),
          ...(typeof preTokens === 'number' ? { preTokens } : {}),
        });
        return;
      }
      // Other system subtypes (init, etc.) are not renderer-relevant.
      return;
    }
    if (evType === 'user') {
      // Not renderer-relevant.
      return;
    }

    // ── Fallthrough: emit raw so nothing is silently dropped ───────────────
    sink({ type: 'raw', line });
  }

  return {
    feed(chunk: string) {
      for (const line of buf.push(chunk)) handleLine(line);
    },
    flush() {
      const tail = buf.drain();
      if (tail) handleLine(tail);
    },
  };
}
