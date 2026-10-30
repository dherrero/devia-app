/**
 * Optional semantic re-ranking for `mem_search` (E-DSK-13 #317, approach A).
 *
 * This runs ONLY inside the agent-invoked `devia-memory` MCP server — never on
 * the prompt-injection hot path. The lexical search produces a candidate pool;
 * this re-orders that pool by embedding cosine similarity to the query. The
 * model (`@xenova/transformers`, all-MiniLM) is lazy-loaded on first use and
 * cached for the process lifetime. ANY failure (dep/model unavailable, etc.)
 * leaves the lexical order untouched — semantic ranking is a pure bonus.
 *
 * The `@xenova/transformers` package is ESM-only; we mirror the voice feature's
 * `await import()` pattern so the CJS-compiled server loads it the same way.
 */

export type Embed = (texts: readonly string[]) => Promise<number[][]>;

/** Cosine similarity of two equal-ish-length vectors; 0 when either is zero. */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Return candidate indices reordered by semantic similarity to the query
 * (highest first). Pure given `embed`; embeds `[query, ...texts]` in one batch.
 */
export async function semanticRankIndices(
  query: string,
  texts: readonly string[],
  embed: Embed,
): Promise<number[]> {
  if (texts.length === 0) return [];
  const vecs = await embed([query, ...texts]);
  const queryVec = vecs[0] ?? [];
  return texts
    .map((_, i) => ({ i, score: cosineSimilarity(queryVec, vecs[i + 1] ?? []) }))
    .sort((p, q) => q.score - p.score)
    .map((x) => x.i);
}

let embedderPromise: Promise<Embed> | null = null;

interface LooseTransformers {
  pipeline: (task: string, model: string, opts?: Record<string, unknown>) => Promise<unknown>;
}
type FeatureExtractor = (
  input: readonly string[],
  opts?: Record<string, unknown>,
) => Promise<{ tolist(): number[][] }>;

/**
 * Lazy, process-cached embedder backed by `@xenova/transformers`. Throws if the
 * dependency/model can't load; the caller is expected to fall back to lexical.
 * On failure the cached promise is cleared so a later call may retry.
 */
export function getEmbedder(): Promise<Embed> {
  if (embedderPromise) return embedderPromise;
  embedderPromise = (async (): Promise<Embed> => {
    const mod = (await import('@xenova/transformers')) as unknown as LooseTransformers;
    const extractor = (await mod.pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
      quantized: true,
    })) as FeatureExtractor;
    return async (texts: readonly string[]): Promise<number[][]> => {
      const out = await extractor(texts, { pooling: 'mean', normalize: true });
      return out.tolist();
    };
  })();
  embedderPromise.catch(() => {
    embedderPromise = null;
  });
  return embedderPromise;
}
