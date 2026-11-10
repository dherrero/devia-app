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

export const LOCAL_ANIMATION_MS = 250;
const NODE_REPULSION = 6500;

export function globalLayoutOptions(): FcoseLayoutOptions {
  return {
    name: 'fcose',
    quality: 'draft',
    randomize: true,
    // The first frame is a fresh graph: animating ~1 s of layout from random spots is noise, not context.
    animate: false,
    animationDuration: 0,
    fit: true,
    padding: 40,
    packComponents: false,
    nodeDimensionsIncludeLabels: false,
    nodeRepulsion: NODE_REPULSION,
    idealEdgeLength: 80,
    edgeElasticity: 0.45,
    numIter: 2500,
  };
}

export function localLayoutOptions(childCount: number, motion: MotionPreference): FcoseLayoutOptions {
  const n = Math.max(1, childCount);
  return {
    name: 'fcose',
    quality: 'draft',
    randomize: true,
    animate: !motion.reducedMotion,
    animationDuration: motion.reducedMotion ? 0 : LOCAL_ANIMATION_MS,
    fit: false,
    padding: 0,
    packComponents: false,
    nodeDimensionsIncludeLabels: false,
    nodeRepulsion: NODE_REPULSION,
    idealEdgeLength: Math.round(Math.min(140, 40 + 4 * Math.sqrt(n))),
    edgeElasticity: 0.45,
    numIter: 1000,
  };
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/**
 * Vogel's sunflower spiral around the parent: deterministic, evenly spaced and
 * compact, so the children appear where the parent was before fcose spreads them
 * (fcose centres each randomized component on its current bounding box).
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
