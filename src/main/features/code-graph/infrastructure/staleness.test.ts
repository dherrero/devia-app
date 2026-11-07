import { describe, expect, it } from 'vitest';
import { computeStaleness } from './staleness';

describe('computeStaleness', () => {
  it('is fresh when nothing differs', () => {
    expect(computeStaleness({ builtAtCommit: 'a', headCommit: 'a', dirtyFiles: 0 })).toEqual({ stale: false, reason: null });
  });

  it('is stale by commit when HEAD moved', () => {
    expect(computeStaleness({ builtAtCommit: 'a', headCommit: 'b', dirtyFiles: 0 })).toEqual({ stale: true, reason: 'commit' });
  });

  it('is never stale by commit without git or without a built commit', () => {
    expect(computeStaleness({ builtAtCommit: 'a', dirtyFiles: 0 })).toEqual({ stale: false, reason: null });
    expect(computeStaleness({ headCommit: 'b', dirtyFiles: 0 })).toEqual({ stale: false, reason: null });
  });

  it('is stale by dirty files', () => {
    expect(computeStaleness({ dirtyFiles: 3 })).toEqual({ stale: true, reason: 'dirty' });
  });

  it('is stale by config', () => {
    expect(computeStaleness({ dirtyFiles: 0, configChanged: true })).toEqual({ stale: true, reason: 'config' });
  });

  it('applies precedence config > commit > dirty', () => {
    const all = { builtAtCommit: 'a', headCommit: 'b', dirtyFiles: 2 };
    expect(computeStaleness({ ...all, configChanged: true }).reason).toBe('config');
    expect(computeStaleness(all).reason).toBe('commit');
    expect(computeStaleness({ builtAtCommit: 'a', headCommit: 'a', dirtyFiles: 2 }).reason).toBe('dirty');
  });
});
