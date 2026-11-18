export interface Point {
  x: number;
  y: number;
}

export interface MotionPreference {
  reducedMotion: boolean;
}

/**
 * The subset of `cytoscape-fcose` options this feature sets. Plain data so the
 * option sets stay testable without loading Cytoscape.
 */
export interface FcoseLayoutOptions {
  name: 'fcose';
  quality: 'draft';
  /** fcose throws on `randomize:false` with the draft quality (spike T-479). */
  randomize: true;
  animate: boolean;
  animationDuration: number;
  fit: boolean;
  padding: number;
  /** Packing disconnected components needs `cytoscape-layout-utilities`, which is not installed. */
  packComponents: false;
  nodeDimensionsIncludeLabels: false;
  nodeRepulsion: number;
  idealEdgeLength: number;
  edgeElasticity: number;
  numIter: number;
}

/** Children fly out of their parent in this time (the spec allows up to 300 ms). */
export const BURST_ANIMATION_MS = 250;
/** Room around a node for its label below it and some air. */
export const BURST_GAP = 24;
const NODE_REPULSION = 6500;

export function globalLayoutOptions(): FcoseLayoutOptions {
  return {
    name: 'fcose',
    quality: 'draft',
    randomize: true,
    // The first frame is a fresh graph: animating ~1 s of layout from random spots is noise, not context.
    animate: false,
    animationDuration: 0,
    // fcose's own fit zooms a tiny overview to the 4x maximum; the renderer fits with fitViewport() instead.
    fit: false,
    padding: 40,
    packComponents: false,
    nodeDimensionsIncludeLabels: false,
    nodeRepulsion: NODE_REPULSION,
    idealEdgeLength: 80,
    edgeElasticity: 0.45,
    numIter: 2500,
  };
}

/** Fitting never zooms in past this: a two-directory overview would otherwise fill the screen with two giant tiles. */
export const FIT_MAX_ZOOM = 1.5;
const FIT_MIN_ZOOM = 0.05;

export interface Box {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface Viewport {
  zoom: number;
  pan: Point;
}

/** The viewport that shows `box` centred in a `view` with `padding`, zoom clamped to [0.05, FIT_MAX_ZOOM]. */
export function fitViewport(box: Box, view: { width: number; height: number }, padding: number): Viewport {
  const w = Math.max(1, box.x2 - box.x1);
  const h = Math.max(1, box.y2 - box.y1);
  const raw = Math.min((view.width - 2 * padding) / w, (view.height - 2 * padding) / h);
  const zoom = Math.min(FIT_MAX_ZOOM, Math.max(FIT_MIN_ZOOM, Number.isFinite(raw) ? raw : FIT_MAX_ZOOM));
  return {
    zoom,
    pan: { x: (view.width - zoom * (box.x1 + box.x2)) / 2, y: (view.height - zoom * (box.y1 + box.y2)) / 2 },
  };
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/**
 * Vogel's sunflower spiral around the parent: deterministic, evenly spaced and
 * compact. Its nearest neighbours sit at least 0.75 × spacing apart.
 */
export function seedChildPositions(parent: Point, n: number, spacing = 24): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < n; i++) {
    const r = spacing * Math.sqrt(i + 0.5);
    const theta = i * GOLDEN_ANGLE;
    out.push({ x: parent.x + r * Math.cos(theta), y: parent.y + r * Math.sin(theta) });
  }
  return out;
}

export interface RunningLayout {
  stop(): void;
  /** Settles when the layout stops, finished or stopped. */
  readonly done: Promise<void>;
}

interface LayoutJob {
  key: string;
  start: () => RunningLayout;
  resolve: () => void;
}

/**
 * Runs at most ONE layout at a time. Requests queue behind the running layout
 * (each explosion still gets its own local layout), a pending request is
 * replaced by a newer one with the same key, and a `preempt` request (the
 * global layout, which repositions everything anyway) stops the running layout
 * and drops the pending ones. Every returned promise settles, even when its
 * job is dropped, fails to start or the queue is disposed.
 */
export class LayoutQueue {
  private running: RunningLayout | null = null;
  private pending: LayoutJob[] = [];
  private disposed = false;

  get busy(): boolean {
    return this.running !== null || this.pending.length > 0;
  }

  enqueue(key: string, start: () => RunningLayout, opts: { preempt?: boolean } = {}): Promise<void> {
    if (this.disposed) return Promise.resolve();
    return new Promise<void>((resolve) => {
      if (opts.preempt) {
        this.dropPending();
        this.running?.stop();
      } else {
        const i = this.pending.findIndex((j) => j.key === key);
        if (i >= 0) this.pending.splice(i, 1)[0]?.resolve();
      }
      this.pending.push({ key, start, resolve });
      this.pump();
    });
  }

  dispose(): void {
    this.disposed = true;
    this.dropPending();
    const running = this.running;
    this.running = null;
    running?.stop();
  }

  private dropPending(): void {
    const dropped = this.pending;
    this.pending = [];
    for (const job of dropped) job.resolve();
  }

  private pump(): void {
    if (this.running || this.disposed) return;
    const job = this.pending.shift();
    if (!job) return;
    let layout: RunningLayout;
    try {
      layout = job.start();
    } catch {
      job.resolve();
      this.pump();
      return;
    }
    this.running = layout;
    const settle = () => {
      if (this.running === layout) this.running = null;
      job.resolve();
      this.pump();
    };
    layout.done.then(settle, settle);
  }
}

export interface Burst {
  positions: Point[];
  /** Radius of the circle the children (with their size and gap) occupy. */
  radius: number;
  /** How far every other node moves away from the centre so nothing is covered. */
  shift: number;
  duration: number;
}

/**
 * Where an explosion puts its children: a sunflower spiral around the parent,
 * spaced by the largest child plus BURST_GAP (the spiral's nearest neighbours sit
 * ≥ 0.75 × spacing apart), and how far the neighbours must move out of its way.
 * Deterministic and O(n), so exploding never waits for a force layout.
 */
export function planBurst(
  center: Point,
  sizes: readonly number[],
  originRadius: number,
  motion: MotionPreference = { reducedMotion: false },
): Burst {
  const duration = motion.reducedMotion ? 0 : BURST_ANIMATION_MS;
  if (sizes.length === 0) return { positions: [], radius: originRadius, shift: 0, duration };
  const maxSize = Math.max(...sizes);
  const positions = seedChildPositions(center, sizes.length, burstSpacing(maxSize));
  const far = Math.max(...positions.map((p) => Math.hypot(p.x - center.x, p.y - center.y)));
  const radius = far + maxSize / 2 + BURST_GAP;
  return { positions, radius, shift: Math.max(0, radius - originRadius), duration };
}

/** The spacing planBurst uses for children of up to `maxSize`. */
export function burstSpacing(maxSize: number): number {
  return (maxSize + BURST_GAP) / 0.75;
}

/**
 * Slots for `count` nodes joining a burst spiral around `center` that already
 * holds `taken` nodes: the next positions of the same spiral, so they land on
 * its rim instead of on top of the siblings.
 */
export function continueSpiral(center: Point, taken: number, count: number, maxSize: number): Point[] {
  return seedChildPositions(center, taken + count, burstSpacing(maxSize)).slice(taken);
}

/** A node that would move less than this is left alone by an animation (no visible change, no work). */
export const MIN_MOVE_PX = 0.5;

/**
 * Radial displacement of a node at distance `d` from a burst: the whole `shift`
 * up to `reach`, then fading out (e-fold every 2 × shift). Its slope stays ≥ 0.5,
 * so the order along a ray is kept (nothing lands on a neighbour) and far
 * nodes barely move, so repeated explosions do not inflate the graph.
 */
function displaced(d: number, shift: number, reach: number): number {
  if (shift <= 0) return d;
  return d <= reach ? d + shift : d + shift * Math.exp(-(d - reach) / (2 * shift));
}

function alongRay(center: Point, p: Point, d: number, target: number): Point {
  if (d < 1e-6) return { x: center.x + target, y: center.y };
  const k = target / d;
  return { x: center.x + (p.x - center.x) * k, y: center.y + (p.y - center.y) * k };
}

export function pushAway(center: Point, p: Point, shift: number, reach: number): Point {
  const d = Math.hypot(p.x - center.x, p.y - center.y);
  return alongRay(center, p, d, displaced(d, shift, reach));
}

/** The inverse of pushAway, except that a node never ends closer than `minDistance` to the centre. */
export function pullBack(center: Point, p: Point, shift: number, reach: number, minDistance: number): Point {
  const d = Math.hypot(p.x - center.x, p.y - center.y);
  let lo = Math.max(0, d - shift);
  let hi = d;
  for (let i = 0; i < 40 && hi - lo > 1e-4; i++) {
    const mid = (lo + hi) / 2;
    if (displaced(mid, shift, reach) < d) lo = mid;
    else hi = mid;
  }
  const original = (lo + hi) / 2;
  if (original < minDistance) return p;
  return alongRay(center, p, d, original);
}

/** A node and its label as one rectangle centred on (x, y). */
export interface CollisionBox {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export const COLLISION_MAX_ITERATIONS = 300;

/**
 * Pushes overlapping boxes apart until each pair keeps `gap` between them (or
 * `maxIterations` runs out). Pairs are found through a uniform grid, so it is
 * ~O(n); each pair separates along the axis it penetrates least, half each.
 * Boxes that coincide are split by id, so the result is deterministic. Returns
 * only the nodes that moved.
 */
export function resolveCollisions(
  boxes: readonly CollisionBox[],
  opts: { gap?: number; maxIterations?: number } = {},
): Map<string, Point> {
  const gap = opts.gap ?? BURST_GAP;
  const maxIterations = opts.maxIterations ?? COLLISION_MAX_ITERATIONS;
  const items = boxes
    .map((b) => ({ id: b.id, x: b.x, y: b.y, hw: b.width / 2 + gap / 2, hh: b.height / 2 + gap / 2, ox: b.x, oy: b.y }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (items.length < 2) return new Map();
  const cell = Math.max(...items.map((i) => 2 * Math.max(i.hw, i.hh)), 1);

  for (let iter = 0; iter < maxIterations; iter++) {
    const grid = new Map<string, number[]>();
    items.forEach((item, idx) => {
      const key = `${Math.floor(item.x / cell)},${Math.floor(item.y / cell)}`;
      const bucket = grid.get(key);
      if (bucket) bucket.push(idx);
      else grid.set(key, [idx]);
    });
    let moved = false;
    items.forEach((a, i) => {
      const cx = Math.floor(a.x / cell);
      const cy = Math.floor(a.y / cell);
      for (let gx = cx - 1; gx <= cx + 1; gx++) {
        for (let gy = cy - 1; gy <= cy + 1; gy++) {
          for (const j of grid.get(`${gx},${gy}`) ?? []) {
            if (j <= i) continue;
            const b = items[j]!;
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const px = a.hw + b.hw - Math.abs(dx);
            const py = a.hh + b.hh - Math.abs(dy);
            if (px <= 0 || py <= 0) continue;
            moved = true;
            if (px <= py) {
              const s = (dx >= 0 ? 1 : -1) * (px / 2 + 0.01);
              a.x -= s;
              b.x += s;
            } else {
              const s = (dy >= 0 ? 1 : -1) * (py / 2 + 0.01);
              a.y -= s;
              b.y += s;
            }
          }
        }
      }
    });
    if (!moved) break;
  }

  const out = new Map<string, Point>();
  for (const i of items) if (i.x !== i.ox || i.y !== i.oy) out.set(i.id, { x: i.x, y: i.y });
  return out;
}
