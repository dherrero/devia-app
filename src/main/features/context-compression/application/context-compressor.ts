import {
  COMPRESS_RATIO,
  estimateTokens,
  type ChatMessageForBudget,
} from '../../../../shared/domain/context-budget';
import {
  AuxiliaryLLMError,
  type AuxiliaryLLMClient,
} from '../infrastructure/auxiliary-llm-client';

/**
 * Context compressor (E-DSK-09 #263).
 *
 * Algorithm — ported from `hermes-agent/agent/context_compressor.py`:
 *   1. Preserve `headKeep` system / summary messages at the head of the
 *      history (they encode persistent instructions and prior
 *      compactions, both load-bearing).
 *   2. Preserve the most recent `tailKeep` turns verbatim — these are
 *      the user's active task; touching them would lose the thread.
 *   3. Hand the middle slice to the auxiliary LLM with the summariser
 *      preamble and stitch the resulting summary back in as a single
 *      `assistant` message flagged `summary: true`.
 *   4. If the resulting history still exceeds the target budget,
 *      re-compress: summarise the summary together with any new
 *      middle slice.
 *
 * Failure mode: on `AuxiliaryLLMError` (no client / API down / quota)
 * the compressor falls back to plain truncation — drop oldest middle
 * messages until under budget — and surfaces a `fallback: 'truncate'`
 * outcome so the runner can audit-log the event.
 */

export interface CompressOptions {
  /**
   * Maximum tokens the compressed history should occupy. The
   * compressor stops re-iterating once the estimate falls below this
   * number. Typically set to `0.6 * modelContextLength` (compressed
   * histories should leave room for the next turn).
   */
  readonly targetBudget: number;
  /** Number of head messages preserved verbatim. Default 1 (system
   *  prompt). The runner can bump this when persistent summary
   *  messages are already at the head. */
  readonly headKeep?: number;
  /** Number of recent turns preserved verbatim. Default 4 — matches
   *  hermes' default. A "turn" here is one message; pairs (user+
   *  assistant) are not coupled so the renderer's session-trim logic
   *  does not need extra hooks. */
  readonly tailKeep?: number;
  /** Maximum re-compression passes. Bound the loop so a degenerate
   *  summary that keeps growing doesn't spin forever. Default 3. */
  readonly maxIterations?: number;
}

export interface CompressedHistory {
  /** The compressed message list, ready to feed to the agent CLI. */
  readonly messages: ReadonlyArray<ChatMessageForBudget>;
  /** True when the compressor actually touched the history; false when
   *  the input was already under budget and no work was needed. */
  readonly didCompress: boolean;
  /** Estimated token count of the returned `messages`. */
  readonly estimatedTokens: number;
  /** How many auxiliary-LLM passes ran. 0 when no compression
   *  happened. */
  readonly iterations: number;
  /** When the auxiliary call failed and the compressor fell back to
   *  truncation, this is `'truncate'`. Otherwise `'summarise'`. */
  readonly fallback: 'truncate' | 'summarise' | 'none';
  /** Auxiliary-LLM error surfaced through truncation. Only present
   *  when `fallback === 'truncate'`. */
  readonly fallbackReason?: string;
}

const SUMMARY_PREFIX = '[Resumen]';

/**
 * Compress `history` so its token estimate fits `opts.targetBudget`.
 *
 * Async because the summariser hop is a network call; pure-truncation
 * fallback still respects the same return shape so callers don't
 * branch on the recovery path.
 */
export async function compress(
  history: ReadonlyArray<ChatMessageForBudget>,
  client: AuxiliaryLLMClient,
  opts: CompressOptions,
): Promise<CompressedHistory> {
  const headKeep = opts.headKeep ?? 1;
  const tailKeep = opts.tailKeep ?? 4;
  const maxIterations = opts.maxIterations ?? 3;

  // Fast path: already under budget.
  let working: ChatMessageForBudget[] = [...history];
  if (estimateTokens(working) <= opts.targetBudget) {
    return {
      messages: working,
      didCompress: false,
      estimatedTokens: estimateTokens(working),
      iterations: 0,
      fallback: 'none',
    };
  }

  let iterations = 0;
  let fallback: 'truncate' | 'summarise' | 'none' = 'none';
  let fallbackReason: string | undefined;

  while (iterations < maxIterations) {
    if (estimateTokens(working) <= opts.targetBudget) break;
    // Need at least one message in the middle worth compressing.
    if (working.length <= headKeep + tailKeep) break;

    const head = working.slice(0, headKeep);
    const tail = working.slice(working.length - tailKeep);
    const middle = working.slice(headKeep, working.length - tailKeep);

    // Per-iteration summary budget: keep it bounded so a degenerate
    // summariser that produces 100k-token output doesn't make the
    // problem worse. 20% of the middle slice (matches hermes' ratio)
    // with a 2k floor / 12k ceiling.
    const middleTokens = estimateTokens(middle);
    const summaryBudget = Math.max(
      2_000,
      Math.min(12_000, Math.floor(middleTokens * 0.2)),
    );

    try {
      const summaryText = await client.summarise({
        messages: middle,
        maxOutputTokens: summaryBudget,
      });
      working = [
        ...head,
        {
          role: 'assistant',
          content: `${SUMMARY_PREFIX} ${summaryText}`,
          summary: true,
        },
        ...tail,
      ];
      fallback = 'summarise';
    } catch (err: unknown) {
      // Aux LLM failed — drop oldest middle messages until under
      // budget. This is the documented degradation path.
      fallback = 'truncate';
      fallbackReason = err instanceof AuxiliaryLLMError
        ? err.message
        : err instanceof Error ? err.message : String(err);
      working = truncateToFitBudget(working, opts.targetBudget, headKeep, tailKeep);
      iterations++;
      break;
    }
    iterations++;
  }

  return {
    messages: working,
    didCompress: true,
    estimatedTokens: estimateTokens(working),
    iterations,
    fallback,
    ...(fallbackReason !== undefined && { fallbackReason }),
  };
}

/**
 * Drop oldest middle messages until the estimate fits the budget. Head
 * and tail slices stay intact — the same protection invariant the
 * summariser path enforces.
 *
 * Exported for testing.
 */
export function truncateToFitBudget(
  history: ReadonlyArray<ChatMessageForBudget>,
  budget: number,
  headKeep: number,
  tailKeep: number,
): ChatMessageForBudget[] {
  const head = history.slice(0, headKeep);
  const tail = history.slice(history.length - tailKeep);
  let middle = history.slice(headKeep, history.length - tailKeep);
  let candidate: ChatMessageForBudget[] = [...head, ...middle, ...tail];
  while (estimateTokens(candidate) > budget && middle.length > 0) {
    middle = middle.slice(1);
    candidate = [...head, ...middle, ...tail];
  }
  return candidate;
}

/**
 * Convenience wrapper that mirrors the runner's call site: estimate
 * tokens, decide whether to compress, and return the (possibly
 * unchanged) history. Pure delegate to {@link compress}; lives here so
 * the runner's pre-spawn block stays a single line.
 */
export async function compressIfOverflow(
  history: ReadonlyArray<ChatMessageForBudget>,
  client: AuxiliaryLLMClient,
  modelBudget: number,
  opts?: Partial<CompressOptions>,
): Promise<CompressedHistory> {
  const trigger = Math.floor(modelBudget * (opts?.targetBudget !== undefined ? 1 : COMPRESS_RATIO));
  if (estimateTokens(history) <= trigger) {
    return {
      messages: history,
      didCompress: false,
      estimatedTokens: estimateTokens(history),
      iterations: 0,
      fallback: 'none',
    };
  }
  return compress(history, client, {
    targetBudget: opts?.targetBudget ?? Math.floor(modelBudget * 0.6),
    headKeep: opts?.headKeep ?? 1,
    tailKeep: opts?.tailKeep ?? 4,
    maxIterations: opts?.maxIterations ?? 3,
  });
}
