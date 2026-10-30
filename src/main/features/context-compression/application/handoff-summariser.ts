import type { ChatMessageForBudget } from '../../../../shared/domain/context-budget';
import { compress } from './context-compressor';
import type { AuxiliaryLLMClient } from '../infrastructure/auxiliary-llm-client';

/**
 * Background LLM enrichment of the cross-agent handoff brief (S-2 F2.3).
 *
 * `RunInstructionUseCase.execute()` is synchronous (the queue dispatcher
 * reads its busy result inline), so the summary can never be awaited at run
 * time. Instead, the moment a handoff becomes FORESEEABLE — agent switch with
 * a foreign-owned session, or switching/adopting a session another agent owns
 * — `prepare()` compresses the transcript's middle section in the background
 * and caches the result. The handoff step consumes the cache synchronously;
 * a miss (still in flight, LLM failed, no client) silently falls back to the
 * deterministic brief. Zero added run latency by construction.
 */

export const HANDOFF_SUMMARY_TTL_MS = 10 * 60_000;
/** Mirrors HANDOFF_TAIL_TURNS: those turns ride the brief verbatim, so the
 *  summary only covers what precedes them. */
const TAIL_KEEP = 4;
const SUMMARY_PREFIX = '[Resumen]';

interface CacheEntry {
  sessionId: string;
  summary: string;
  createdAt: number;
}

export interface HandoffSummariserDeps {
  /** Resolved at call time so an agent/env change picks the right provider. */
  client: () => AuxiliaryLLMClient;
  /** False ⇒ `prepare()` no-ops without ever invoking the client. */
  clientAvailable: () => boolean;
  now?: () => number;
}

export class HandoffSummariser {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Set<string>();

  constructor(private readonly deps: HandoffSummariserDeps) {}

  /**
   * Kick off (fire-and-forget) the compression of `messages` for a session
   * that will hand off when continued under `identity`. Deduped per identity;
   * a fresh cached entry for the same session is never recomputed.
   */
  prepare(identity: string, sessionId: string, messages: readonly unknown[]): void {
    if (!this.deps.clientAvailable()) return;
    const budgetMessages = toBudgetMessages(messages);
    // Nothing beyond the verbatim tail — the deterministic brief already
    // carries everything; an LLM call would only add cost.
    if (budgetMessages.length <= TAIL_KEEP) return;
    if (this.inFlight.has(identity)) return;
    const cached = this.cache.get(identity);
    if (cached && cached.sessionId === sessionId && this.fresh(cached)) return;

    this.inFlight.add(identity);
    void compress(budgetMessages, this.deps.client(), {
      targetBudget: 1, // force one summarisation pass over the middle slice
      headKeep: 0,
      tailKeep: TAIL_KEEP,
      maxIterations: 1,
    })
      .then((result) => {
        if (result.fallback !== 'summarise') return; // LLM failed → keep deterministic
        const summaryMsg = result.messages.find((m) => m.summary === true);
        const text = typeof summaryMsg?.content === 'string' ? summaryMsg.content : '';
        const summary = text.startsWith(SUMMARY_PREFIX)
          ? text.slice(SUMMARY_PREFIX.length).trim()
          : text.trim();
        if (summary.length === 0) return;
        this.cache.set(identity, { sessionId, summary, createdAt: this.now() });
      })
      .catch(() => {
        /* compress() reports failures via `fallback`; this is a hard guard */
      })
      .finally(() => {
        this.inFlight.delete(identity);
      });
  }

  /**
   * Fresh summary for (identity, sessionId), or null. One-shot: a consumed
   * entry is dropped (after the handoff the mismatch clears, so a stale
   * summary must never leak into a later, unrelated handoff).
   */
  consume(identity: string, sessionId: string): string | null {
    const entry = this.cache.get(identity);
    if (!entry) return null;
    if (entry.sessionId !== sessionId || !this.fresh(entry)) {
      this.cache.delete(identity);
      return null;
    }
    this.cache.delete(identity);
    return entry.summary;
  }

  private fresh(entry: CacheEntry): boolean {
    return this.now() - entry.createdAt < HANDOFF_SUMMARY_TTL_MS;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
}

/** Project a persisted transcript onto the compressor's message shape,
 *  keeping only user/assistant turns with text. Defensive: messages cross the
 *  persistence boundary as `unknown[]`. */
export function toBudgetMessages(messages: readonly unknown[]): ChatMessageForBudget[] {
  const result: ChatMessageForBudget[] = [];
  for (const raw of messages) {
    if (!raw || typeof raw !== 'object') continue;
    const msg = raw as { role?: unknown; text?: unknown; kind?: unknown };
    if (msg.kind === 'handoff') continue; // a previous handoff divider is meta, not conversation
    if (msg.role !== 'user' && msg.role !== 'assistant') continue;
    const text = typeof msg.text === 'string' ? msg.text.trim() : '';
    if (text.length === 0) continue;
    result.push({ role: msg.role, content: text });
  }
  return result;
}
