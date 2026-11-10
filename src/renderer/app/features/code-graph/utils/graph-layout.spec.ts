import { describe, expect, it, vi } from 'vitest';

import {
  LOCAL_ANIMATION_MS, LayoutQueue, globalLayoutOptions, localLayoutOptions, seedChildPositions,
  type RunningLayout,
} from './graph-layout';

function controllable() {
  let finish: () => void = () => undefined;
  const done = new Promise<void>((resolve) => (finish = resolve));
  const stop = vi.fn(() => finish());
  const layout: RunningLayout = { stop, done };
  return { layout, finish: () => finish(), stop };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('fcose option sets (S-44 T-510)', () => {
  it('lays the first load out globally in draft quality, fitted, without packing', () => {
    const o = globalLayoutOptions();
    expect(o).toMatchObject({ name: 'fcose', quality: 'draft', randomize: true, fit: true, animate: false, packComponents: false });
  });

  it('lays an explosion out locally: randomize, animated 250 ms, never fitting the viewport', () => {
    const o = localLayoutOptions(20, { reducedMotion: false });
    expect(o).toMatchObject({
      name: 'fcose', quality: 'draft', randomize: true, animate: true, animationDuration: LOCAL_ANIMATION_MS,
      fit: false, packComponents: false,
    });
    expect(LOCAL_ANIMATION_MS).toBe(250);
    expect(o.nodeRepulsion).toBe(localLayoutOptions(400, { reducedMotion: false }).nodeRepulsion);
  });

  it('skips the animation when reduced motion is requested', () => {
    const o = localLayoutOptions(20, { reducedMotion: true });
    expect(o.animate).toBe(false);
    expect(o.animationDuration).toBe(0);
    expect(o.randomize).toBe(true);
  });

  it('scales the ideal edge length with the number of children, bounded', () => {
    const few = localLayoutOptions(3, { reducedMotion: false }).idealEdgeLength;
    const many = localLayoutOptions(500, { reducedMotion: false }).idealEdgeLength;
    expect(many).toBeGreaterThan(few);
    expect(localLayoutOptions(1e6, { reducedMotion: false }).idealEdgeLength).toBe(localLayoutOptions(1e7, { reducedMotion: false }).idealEdgeLength);
  });
});

describe('seedChildPositions (S-44 T-510)', () => {
  it('is deterministic and centred on the parent', () => {
    const a = seedChildPositions({ x: 100, y: -50 }, 40);
    expect(a).toEqual(seedChildPositions({ x: 100, y: -50 }, 40));
    expect(a).toHaveLength(40);
    const cx = a.reduce((s, p) => s + p.x, 0) / a.length;
    const cy = a.reduce((s, p) => s + p.y, 0) / a.length;
    expect(Math.abs(cx - 100)).toBeLessThan(15);
    expect(Math.abs(cy + 50)).toBeLessThan(15);
  });

  it('places no two children on top of each other', () => {
    const spacing = 24;
    const pts = seedChildPositions({ x: 0, y: 0 }, 300, spacing);
    let min = Infinity;
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const a = pts[i];
        const b = pts[j];
        if (a && b) min = Math.min(min, Math.hypot(a.x - b.x, a.y - b.y));
      }
    }
    expect(min).toBeGreaterThanOrEqual(spacing * 0.75);
  });

  it('keeps the children close to the parent (no teleporting)', () => {
    const pts = seedChildPositions({ x: 0, y: 0 }, 500, 24);
    const far = Math.max(...pts.map((p) => Math.hypot(p.x, p.y)));
    expect(far).toBeLessThan(24 * Math.sqrt(500) + 24);
  });

  it('returns nothing for zero children', () => {
    expect(seedChildPositions({ x: 0, y: 0 }, 0)).toEqual([]);
  });
});

describe('LayoutQueue (S-44 T-510)', () => {
  it('runs one layout at a time, queueing the next until the running one ends', async () => {
    const q = new LayoutQueue();
    const first = controllable();
    const second = controllable();
    const startSecond = vi.fn(() => second.layout);

    const p1 = q.enqueue('a', () => first.layout);
    const p2 = q.enqueue('b', startSecond);
    await flush();
    expect(startSecond).not.toHaveBeenCalled();
    expect(q.busy).toBe(true);

    first.finish();
    await p1;
    await flush();
    expect(startSecond).toHaveBeenCalledTimes(1);
    second.finish();
    await p2;
    expect(q.busy).toBe(false);
  });

  it('replaces a still-pending request with the same key (the latest one wins)', async () => {
    const q = new LayoutQueue();
    const first = controllable();
    const stale = vi.fn(() => controllable().layout);
    const fresh = controllable();
    const startFresh = vi.fn(() => fresh.layout);

    void q.enqueue('a', () => first.layout);
    const pStale = q.enqueue('b', stale);
    const pFresh = q.enqueue('b', startFresh);
    first.finish();
    await pStale;
    await flush();
    expect(stale).not.toHaveBeenCalled();
    expect(startFresh).toHaveBeenCalledTimes(1);
    fresh.finish();
    await pFresh;
  });

  it('a preempting request stops the running layout and drops the pending ones', async () => {
    const q = new LayoutQueue();
    const running = controllable();
    const pending = vi.fn(() => controllable().layout);
    const global = controllable();

    void q.enqueue('a', () => running.layout);
    const pPending = q.enqueue('b', pending);
    const pGlobal = q.enqueue('global', () => global.layout, { preempt: true });
    expect(running.stop).toHaveBeenCalledTimes(1);
    await pPending;
    await flush();
    expect(pending).not.toHaveBeenCalled();
    global.finish();
    await pGlobal;
  });

  it('keeps going when a layout fails to start', async () => {
    const q = new LayoutQueue();
    const next = controllable();
    const startNext = vi.fn(() => next.layout);
    const p1 = q.enqueue('a', () => {
      throw new Error('boom');
    });
    const p2 = q.enqueue('b', startNext);
    await expect(p1).resolves.toBeUndefined();
    await flush();
    expect(startNext).toHaveBeenCalled();
    next.finish();
    await p2;
  });

  it('dispose() stops the running layout, drops the queue and refuses new work', async () => {
    const q = new LayoutQueue();
    const running = controllable();
    const pending = vi.fn(() => controllable().layout);
    void q.enqueue('a', () => running.layout);
    const p = q.enqueue('b', pending);
    q.dispose();
    expect(running.stop).toHaveBeenCalled();
    await p;
    const late = vi.fn(() => controllable().layout);
    await q.enqueue('c', late);
    expect(pending).not.toHaveBeenCalled();
    expect(late).not.toHaveBeenCalled();
    expect(q.busy).toBe(false);
  });
});
