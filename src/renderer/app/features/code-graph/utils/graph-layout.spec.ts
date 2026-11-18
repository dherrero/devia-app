import { describe, expect, it, vi } from 'vitest';

import {
  BURST_ANIMATION_MS, BURST_GAP, FIT_MAX_ZOOM, LayoutQueue, resolveCollisions, type CollisionBox, fitViewport, globalLayoutOptions, planBurst, pullBack, pushAway,
  seedChildPositions, type Point, type RunningLayout,
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
  it('lays the first load out globally in draft quality, without packing, leaving the fit to fitViewport', () => {
    const o = globalLayoutOptions();
    expect(o).toMatchObject({ name: 'fcose', quality: 'draft', randomize: true, fit: false, animate: false, packComponents: false });
  });
});

describe('burst placement (S-44 T-510)', () => {
  const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

  it('places the children around the parent with room for each node and its label', () => {
    const sizes = [60, 60, 40, 60, 60, 60, 60, 60];
    const plan = planBurst({ x: 100, y: 100 }, sizes, 30);
    expect(plan.positions).toHaveLength(8);
    for (let i = 0; i < plan.positions.length; i++) {
      for (let j = i + 1; j < plan.positions.length; j++) {
        const a = plan.positions[i];
        const b = plan.positions[j];
        if (a && b) expect(dist(a, b)).toBeGreaterThanOrEqual(60 + BURST_GAP);
      }
    }
    expect(plan.duration).toBe(BURST_ANIMATION_MS);
  });

  it('measures how far the neighbours must move so the burst never covers them', () => {
    const plan = planBurst({ x: 0, y: 0 }, [20, 20, 20, 20, 20], 10);
    const far = Math.max(...plan.positions.map((p) => Math.hypot(p.x, p.y)));
    expect(plan.radius).toBeGreaterThanOrEqual(far + 10);
    expect(plan.shift).toBeCloseTo(plan.radius - 10);
    expect(planBurst({ x: 0, y: 0 }, [], 30).shift).toBe(0);
  });

  it('pushes a nearby neighbour radially away by the whole shift and pulls it back exactly', () => {
    const c = { x: 10, y: 10 };
    const pushed = pushAway(c, { x: 40, y: 50 }, 100, 80);
    expect(dist(pushed, c)).toBeCloseTo(150);
    expect((pushed.y - c.y) / (pushed.x - c.x)).toBeCloseTo(40 / 30);
    const back = pullBack(c, pushed, 100, 80, 20);
    expect(back.x).toBeCloseTo(40);
    expect(back.y).toBeCloseTo(50);
  });

  it('keeps the push local: far nodes barely move, so repeated explosions do not inflate the graph', () => {
    const c = { x: 0, y: 0 };
    const far = pushAway(c, { x: 3000, y: 0 }, 200, 250);
    expect(far.x - 3000).toBeLessThan(10);
    const back = pullBack(c, far, 200, 250, 0);
    expect(back.x).toBeCloseTo(3000);
  });

  it('never reorders nodes along a ray (monotonic), so pushed nodes cannot land on each other', () => {
    const c = { x: 0, y: 0 };
    let previous = -Infinity;
    for (let d = 0; d < 3000; d += 7) {
      const x = pushAway(c, { x: d, y: 0 }, 300, 200).x;
      expect(x).toBeGreaterThan(previous);
      expect(pullBack(c, { x, y: 0 }, 300, 200, 0).x).toBeCloseTo(d);
      previous = x;
    }
  });

  it('never pulls a node into the restored parent, and moves a node at the centre in some direction', () => {
    const c = { x: 0, y: 0 };
    expect(pullBack(c, { x: 50, y: 0 }, 100, 80, 40)).toEqual({ x: 50, y: 0 });
    expect(dist(pushAway(c, c, 30, 50), c)).toBeCloseTo(30);
  });

  it('does not animate under reduced motion', () => {
    expect(planBurst({ x: 0, y: 0 }, [20], 10, { reducedMotion: true }).duration).toBe(0);
  });
});

describe('fitViewport (S-44 T-510)', () => {
  const view = { width: 1000, height: 600 };

  it('fits a large graph inside the padded view, centred', () => {
    const v = fitViewport({ x1: 0, y1: 0, x2: 2000, y2: 600 }, view, 50);
    expect(v.zoom).toBeCloseTo(0.45);
    expect(v.pan.x).toBeCloseTo(50);
    expect(v.pan.y).toBeCloseTo(300 - 0.45 * 300);
  });

  it('never zooms a small graph past FIT_MAX_ZOOM (no giant nodes for a two-directory overview)', () => {
    const v = fitViewport({ x1: 100, y1: 100, x2: 200, y2: 140 }, view, 40);
    expect(v.zoom).toBe(FIT_MAX_ZOOM);
    expect(150 * v.zoom + v.pan.x).toBeCloseTo(500);
    expect(120 * v.zoom + v.pan.y).toBeCloseTo(300);
  });

  it('handles an empty or zero-size view without NaN', () => {
    const v = fitViewport({ x1: 5, y1: 5, x2: 5, y2: 5 }, { width: 0, height: 0 }, 40);
    expect(Number.isFinite(v.zoom) && v.zoom > 0).toBe(true);
    expect(Number.isFinite(v.pan.x) && Number.isFinite(v.pan.y)).toBe(true);
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

describe('collision resolution (S-48)', () => {
  const box = (id: string, x: number, y: number, w = 60, h = 80): CollisionBox => ({ id, x, y, width: w, height: h });
  const apply = (boxes: CollisionBox[]) => {
    const moved = resolveCollisions(boxes);
    return boxes.map((b) => ({ ...b, ...(moved.get(b.id) ?? {}) }));
  };
  const overlaps = (a: CollisionBox, b: CollisionBox, gap = BURST_GAP) =>
    Math.abs(a.x - b.x) < (a.width + b.width) / 2 + gap - 0.5 && Math.abs(a.y - b.y) < (a.height + b.height) / 2 + gap - 0.5;
  const anyOverlap = (bs: CollisionBox[]) => bs.some((a, i) => bs.slice(i + 1).some((b) => overlaps(a, b)));

  it('separates boxes sitting on the same point, deterministically', () => {
    const input = [box('a', 0, 0), box('b', 0, 0)];
    const first = apply(input);
    expect(anyOverlap(first)).toBe(false);
    expect(apply(input)).toEqual(first);
  });

  it('separates the stacked tests / resources / vitest.config.ts nodes of the first screen', () => {
    const out = apply([box('tests', 0, 0, 68, 90), box('resources', 0, 20, 60, 90), box('vitest.config.ts', 0, 45, 120, 70)]);
    expect(anyOverlap(out)).toBe(false);
  });

  it('leaves already separated boxes alone', () => {
    expect(resolveCollisions([box('a', 0, 0), box('b', 500, 0)]).size).toBe(0);
  });

  it('settles 3000 random boxes quickly and without residual overlaps', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const boxes = Array.from({ length: 3000 }, (_, i) => box(`n${i}`, rnd() * 9000, rnd() * 9000, 20 + rnd() * 60, 30 + rnd() * 60));
    const t = Date.now();
    const out = apply(boxes);
    expect(Date.now() - t).toBeLessThan(1000);
    expect(anyOverlap(out)).toBe(false);
  });

  it('does not fling a simple overlap far away', () => {
    const out = apply([box('a', 0, 0), box('b', 10, 0)]);
    for (const o of out) expect(Math.hypot(o.x, o.y)).toBeLessThan(200);
  });
});
