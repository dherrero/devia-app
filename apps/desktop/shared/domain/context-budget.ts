/**
 * Per-model context-window LUT ported from
 * `hermes-agent/agent/model_metadata.py` and a `~chars/4` token estimator
 * (E-DSK-09 #263). Lives in `shared/` so the compressor (main) and the
 * renderer "Optimizando conversación…" status both consume the same
 * constants.
 *
 * Heuristic vs. real tokenizer:
 *   We picked the chars/4 estimate over `gpt-tokenizer` (~5 MB) so the
 *   renderer bundle stays slim and the main process boots without an
 *   expensive WASM init. The estimate is biased ~10-15% conservative
 *   (real tokens / chars ≈ 4.0 for english, ≈ 5.0 for code) which is
 *   the safe side: we'd compress a little earlier than strictly
 *   necessary rather than blow the context window. Hermes uses the
 *   same chars/4 heuristic for the same reason — see
 *   `_CHARS_PER_TOKEN` in `context_compressor.py`.
 *
 *   When a model's context window is so large that the estimate's
 *   tail-end inaccuracy matters (Gemini 1M+, Sonnet long-context tier)
 *   the compressor's iterative re-compression pass picks up the slack
 *   on the second pass if the first wasn't aggressive enough.
 */

export interface ChatMessageForBudget {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string | ReadonlyArray<{ type: string; text?: string; [k: string]: unknown }>;
  /** Flagged on messages that were already produced as a summary so the
   *  compressor's preservation logic can treat them as "head". */
  readonly summary?: boolean;
}

/** Lower bound applied to any model we don't recognise — picked
 *  defensively so unknown models never bypass compression. Matches
 *  hermes' MINIMUM_CONTEXT_LENGTH. */
export const MINIMUM_CONTEXT_LENGTH = 64_000;

/** Cost per attached image part. Matches hermes' _IMAGE_TOKEN_COST. */
export const IMAGE_TOKEN_COST = 1_500;

/** Default compression trigger: when estimated tokens exceed
 *  `BUDGET * COMPRESS_RATIO`, the compressor runs. */
export const COMPRESS_RATIO = 0.8;

/**
 * Per-model context-window length (in tokens). Keys are normalised
 * lowercase model ids — callers should lowercase before lookup. The
 * `default` key per CLI is used when a more specific model id is unknown.
 *
 * Numbers are pulled from each vendor's docs as of 2026-05; mismatches
 * surface as `unknown` lookups which fall back to MINIMUM_CONTEXT_LENGTH.
 */
const MODEL_CONTEXT_LENGTH: Readonly<Record<string, number>> = {
  // Anthropic
  'claude-opus-4-7': 200_000,
  'claude-opus-4-6': 200_000,
  'claude-sonnet-4-7': 200_000,
  'claude-sonnet-4-6': 200_000,
  'claude-haiku-4-5': 200_000,
  'claude-default': 200_000,

  // OpenAI / Codex
  'gpt-5': 256_000,
  'gpt-5-mini': 256_000,
  'gpt-4o': 128_000,
  'gpt-4o-mini': 128_000,
  'codex-default': 256_000,

  // Google
  'gemini-2.5-pro': 1_048_576,
  'gemini-2.5-flash': 1_048_576,
  'gemini-default': 1_048_576,

  // Open-source / aggregated providers
  'qwen-coder-3': 128_000,
  'qwen-default': 128_000,
  'deepseek-chat': 128_000,
  'deepseek-coder': 128_000,
  'deepseek-default': 128_000,

  // Aggregator / CLI-specific defaults
  'opencode-default': 128_000,
  'cursor-default': 200_000,
  'copilot-default': 128_000,
  'qoder-default': 128_000,
  'pi-default': 200_000,
};

/**
 * Resolve the context-window length for a given CLI + optional model id.
 * Lookup order:
 *   1. `<model id>` exact match (lowercased)
 *   2. `<cliId>-default` family fallback
 *   3. {@link MINIMUM_CONTEXT_LENGTH}
 *
 * The lookup is forgiving on purpose — adding a new model that isn't
 * yet in the table won't crash the runner, just makes compression
 * conservative.
 */
export function getModelContextLength(cliId: string, model?: string): number {
  if (model) {
    const direct = MODEL_CONTEXT_LENGTH[model.toLowerCase()];
    if (direct !== undefined) return direct;
  }
  const family = MODEL_CONTEXT_LENGTH[`${cliId}-default`];
  return family ?? MINIMUM_CONTEXT_LENGTH;
}

/**
 * Hysteresis band for the statusbar's "context almost full" alert (S-1 T-5).
 * `enter` once usage crosses {@link COMPRESS_RATIO} (the same threshold the
 * compressor uses), `exit` once it falls back under the re-arm floor, and
 * `hold` in the dead-band between the two. The caller keeps the per-project
 * armed/disarmed state and only reacts to `enter`/`exit`, so a percentage
 * hovering around the threshold never flaps the alert. The default 0.1 gap
 * means: warn at ≥80%, re-arm under 70%.
 */
export type ContextAlertBand = 'enter' | 'hold' | 'exit';

/** Re-arm floor for the context alert: COMPRESS_RATIO (0.8) minus a 0.1
 *  hysteresis gap. A literal (not `COMPRESS_RATIO - 0.1`) so the boundary is
 *  exactly 0.70 and not 0.7000000000000001 from float subtraction. */
export const CONTEXT_ALERT_REARM_RATIO = 0.7;

export function contextAlertBand(
  pct: number,
  warnRatio: number = COMPRESS_RATIO,
  rearmRatio: number = CONTEXT_ALERT_REARM_RATIO,
): ContextAlertBand {
  if (pct >= warnRatio) return 'enter';
  if (pct < rearmRatio) return 'exit';
  return 'hold';
}

/** ~chars per token for the heuristic estimator (matches the chars/4 rule). */
const CHARS_PER_TOKEN = 4;

/**
 * Character budget for the injected memory block (E-DSK-13 #319). The block is
 * a small slice of the active model's context window — capped to ≤1.5% of the
 * window, clamped to 300–1500 tokens — so a tiny local model (≈64k) gets a
 * compact block while a 200k/1M model can afford a richer one, without ever
 * dominating the prompt. Returned in characters for `buildMemoryContextHint`.
 */
export function memoryHintBudgetChars(cliId: string, model?: string): number {
  const windowTokens = getModelContextLength(cliId, model);
  const memoryTokens = Math.min(1_500, Math.max(300, Math.round(windowTokens * 0.015)));
  return memoryTokens * CHARS_PER_TOKEN;
}

/**
 * Character budget for the transcript re-seeded into the prompt of
 * `continuity: 'replay'` agents (S-19 F0). Unlike the small memory block, the
 * replayed transcript IS the agent's only carrier of prior context, so it gets
 * a more generous slice of the active model's window — ~10% of the window,
 * clamped to 1500–8000 tokens — bounded enough to keep per-turn cost in check
 * while preserving a useful tail of the conversation. Returned in characters.
 */
export function replayBudgetChars(cliId: string, model?: string): number {
  const windowTokens = getModelContextLength(cliId, model);
  const replayTokens = Math.min(8_000, Math.max(1_500, Math.round(windowTokens * 0.1)));
  return replayTokens * CHARS_PER_TOKEN;
}

/**
 * Compute the per-message character count used as the input to the
 * `chars/4` token estimate. Multimodal parts contribute via image
 * fingerprint, not raw base64 chars (a 1 MB screenshot would otherwise
 * be estimated at ~250k tokens and trigger spurious compression).
 */
function messageChars(msg: ChatMessageForBudget): { chars: number; images: number } {
  let chars = 0;
  let images = 0;
  const c = msg.content;
  if (typeof c === 'string') {
    chars += c.length;
  } else if (Array.isArray(c)) {
    for (const part of c) {
      if (part.type === 'image' || part.type === 'image_url' || part.type === 'input_image') {
        images++;
        continue;
      }
      if (typeof part['text'] === 'string') chars += (part['text'] as string).length;
    }
  }
  return { chars, images };
}

/**
 * Rough token count for an entire history. Used pre-spawn to decide
 * whether compression should kick in. Never throws on malformed input —
 * unrecognised content shapes contribute 0 to the total so a corrupt
 * record can't crash the compression check.
 */
export function estimateTokens(messages: ReadonlyArray<ChatMessageForBudget>): number {
  let totalChars = 0;
  let totalImages = 0;
  for (const m of messages) {
    try {
      const { chars, images } = messageChars(m);
      totalChars += chars;
      totalImages += images;
    } catch {
      /* swallow: malformed entries contribute 0 */
    }
  }
  return Math.ceil(totalChars / 4) + totalImages * IMAGE_TOKEN_COST;
}

/**
 * Returns true when the estimated tokens exceed `COMPRESS_RATIO * budget`.
 * Pure convenience around {@link estimateTokens} so callers don't sprinkle
 * the ratio constant across the codebase.
 */
export function shouldCompress(
  messages: ReadonlyArray<ChatMessageForBudget>,
  budget: number,
  ratio: number = COMPRESS_RATIO,
): boolean {
  return estimateTokens(messages) > Math.floor(budget * ratio);
}
