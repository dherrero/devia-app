import { describe, it, expect } from 'vitest';
import { cosineSimilarity, semanticRankIndices, type Embed } from './semantic-rerank';

describe('cosineSimilarity', () => {
  it('is 1 for identical, 0 for orthogonal, -1 for opposite', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1);
  });

  it('returns 0 when either vector is zero', () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
});

describe('semanticRankIndices', () => {
  // Fake embedder mapping known phrases to fixed 2-D vectors.
  const vectors: Record<string, number[]> = {
    q: [1, 0],
    a: [0, 1], // orthogonal to q
    b: [0.9, 0.1], // close to q
    c: [-1, 0], // opposite to q
  };
  const embed: Embed = async (texts) => texts.map((t) => vectors[t] ?? [0, 0]);

  it('orders candidates by similarity to the query (highest first)', async () => {
    const order = await semanticRankIndices('q', ['a', 'b', 'c'], embed);
    expect(order).toEqual([1, 0, 2]); // b (closest), a (orthogonal), c (opposite)
  });

  it('returns [] for no candidates', async () => {
    expect(await semanticRankIndices('q', [], embed)).toEqual([]);
  });
});
