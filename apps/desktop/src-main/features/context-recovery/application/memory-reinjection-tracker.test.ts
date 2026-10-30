import { describe, expect, it } from 'vitest';
import { MemoryReinjectionTracker } from './memory-reinjection-tracker';

describe('MemoryReinjectionTracker', () => {
  it('reports nothing pending for an unknown project', () => {
    const t = new MemoryReinjectionTracker();
    expect(t.isPending('/p')).toBe(false);
    expect(t.consume('/p')).toBe(false);
  });

  it('marks a compaction and exposes it as pending', () => {
    const t = new MemoryReinjectionTracker();
    t.markCompacted('/p');
    expect(t.isPending('/p')).toBe(true);
  });

  it('consume returns true once then clears the flag (one-shot)', () => {
    const t = new MemoryReinjectionTracker();
    t.markCompacted('/p');
    expect(t.consume('/p')).toBe(true);
    expect(t.consume('/p')).toBe(false);
    expect(t.isPending('/p')).toBe(false);
  });

  it('tracks projects independently', () => {
    const t = new MemoryReinjectionTracker();
    t.markCompacted('/a');
    expect(t.isPending('/a')).toBe(true);
    expect(t.isPending('/b')).toBe(false);
    expect(t.consume('/b')).toBe(false);
    expect(t.consume('/a')).toBe(true);
  });

  it('coalesces repeated compactions into a single pending re-injection', () => {
    const t = new MemoryReinjectionTracker();
    t.markCompacted('/p');
    t.markCompacted('/p');
    t.markCompacted('/p');
    expect(t.consume('/p')).toBe(true);
    expect(t.consume('/p')).toBe(false);
  });

  it('clear drops a pending flag without reporting it', () => {
    const t = new MemoryReinjectionTracker();
    t.markCompacted('/p');
    t.clear('/p');
    expect(t.isPending('/p')).toBe(false);
    expect(t.consume('/p')).toBe(false);
  });
});
