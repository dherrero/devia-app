import { randomUUID } from 'node:crypto';
import type { ProjectRegistry } from '../../../shared/ports';
import type {
  ProjectQueueView,
  QueueChangedEvent,
  QueueItem,
} from '../../../../shared/domain/queue';
import type {
  InstructionDispatcher,
  QueueRepository,
  QueueRepositorySnapshot,
} from '../domain/ports';

interface MutableQueue {
  items: QueueItem[];
  paused: boolean;
}

export interface QueueServiceDeps {
  repo: QueueRepository;
  registry: ProjectRegistry;
}

/**
 * Owns the in-memory state of every per-project queue and the side
 * effects that go with mutating one (persist + notify renderer).
 *
 * Both the dispatcher and the notify callback are wired *after*
 * construction because they depend on services that themselves depend
 * on this one — the runner needs `shouldEnqueue` and the feature
 * registration callback owns the renderer-facing `ctx.send`.
 */
export class QueueService {
  private readonly queues = new Map<string, MutableQueue>();
  private dispatcher: InstructionDispatcher | null = null;
  private notify: (e: QueueChangedEvent) => void = () => { /* set in attachNotify */ };

  constructor(private readonly deps: QueueServiceDeps) {}

  attachNotify(fn: (e: QueueChangedEvent) => void): void {
    this.notify = fn;
  }

  // ── Bootstrap ────────────────────────────────────────────────────────
  hydrate(initial: Map<string, QueueRepositorySnapshot>): void {
    this.queues.clear();
    for (const [project, snap] of initial) {
      this.queues.set(project, {
        items: snap.items.map((it) => ({ ...it })),
        paused: snap.paused,
      });
    }
  }

  attachDispatcher(dispatcher: InstructionDispatcher): void {
    this.dispatcher = dispatcher;
  }

  // ── Reads ────────────────────────────────────────────────────────────
  view(projectName: string): ProjectQueueView {
    const q = this.queues.get(projectName);
    if (!q) return { items: [], paused: false };
    return {
      items: q.items.map((it) => ({ ...it })),
      paused: q.paused,
    };
  }

  /**
   * True when a freshly-arrived instruction must go into the queue
   * instead of running inline. Matches the spec literally: busy, or
   * paused with at least one item already parked.
   */
  shouldEnqueue(projectName: string): boolean {
    if (this.deps.registry.isRunning(projectName)) return true;
    const q = this.queues.get(projectName);
    if (q && q.paused && q.items.length > 0) return true;
    return false;
  }

  // ── Mutations ────────────────────────────────────────────────────────
  add(
    projectName: string,
    text: string,
    opts?: {
      displayText?: string;
      mode?: QueueItem['mode'];
      origin?: 'renderer' | 'remote';
      baseProject?: string;
      runKey?: string;
      isolate?: boolean;
      sessionId?: string;
      agentIdOverride?: string;
    },
  ): QueueItem {
    const trimmed = text.trim();
    if (!trimmed) {
      throw new Error('Cannot enqueue empty instruction');
    }
    const q = this.ensure(projectName);
    const item: QueueItem = {
      id: randomUUID(),
      text: trimmed,
      createdAt: Date.now(),
      ...(opts?.displayText !== undefined && { displayText: opts.displayText }),
      ...(opts?.mode !== undefined && { mode: opts.mode }),
      // Only persist non-default origins so existing queue files stay lean.
      ...(opts?.origin === 'remote' ? { origin: opts.origin } : {}),
      // Split-view run context (T-143): only stored for additional panes.
      ...(opts?.baseProject !== undefined && { baseProject: opts.baseProject }),
      ...(opts?.runKey !== undefined && { runKey: opts.runKey }),
      ...(opts?.isolate === true && { isolate: true }),
      ...(opts?.sessionId !== undefined && { sessionId: opts.sessionId }),
      ...(opts?.agentIdOverride !== undefined && { agentIdOverride: opts.agentIdOverride }),
    };
    q.items.push(item);
    this.persistAndNotify(projectName);
    return item;
  }

  remove(projectName: string, id: string): boolean {
    const q = this.queues.get(projectName);
    if (!q) return false;
    const idx = q.items.findIndex((it) => it.id === id);
    if (idx === -1) return false;
    q.items.splice(idx, 1);
    this.persistAndNotify(projectName);
    return true;
  }

  edit(projectName: string, id: string, newText: string): boolean {
    const trimmed = newText.trim();
    if (!trimmed) return false;
    const q = this.queues.get(projectName);
    if (!q) return false;
    const item = q.items.find((it) => it.id === id);
    if (!item) return false;
    if (item.text === trimmed) return true;
    item.text = trimmed;
    this.persistAndNotify(projectName);
    return true;
  }

  move(projectName: string, id: string, newIndex: number): boolean {
    const q = this.queues.get(projectName);
    if (!q) return false;
    const from = q.items.findIndex((it) => it.id === id);
    if (from === -1) return false;
    const clamped = Math.max(0, Math.min(newIndex, q.items.length - 1));
    if (from === clamped) return true;
    const moved = q.items.splice(from, 1)[0];
    if (!moved) return false;
    q.items.splice(clamped, 0, moved);
    this.persistAndNotify(projectName);
    return true;
  }

  clear(projectName: string): boolean {
    const q = this.queues.get(projectName);
    if (!q || q.items.length === 0) return false;
    q.items = [];
    this.persistAndNotify(projectName);
    return true;
  }

  pause(projectName: string): boolean {
    const q = this.ensure(projectName);
    if (q.paused) return true;
    q.paused = true;
    this.persistAndNotify(projectName);
    return true;
  }

  /**
   * Lifts the pause flag and, when the project isn't running and items
   * remain, kicks the head item — same code path the post-process-end
   * hook uses, so behavior is symmetric.
   */
  resume(projectName: string): boolean {
    const q = this.queues.get(projectName);
    if (!q) return true;
    if (!q.paused) return true;
    q.paused = false;
    this.persistAndNotify(projectName);
    this.dispatchNext(projectName);
    return true;
  }

  /**
   * Hook invoked when a Claude run finishes (success, error, or stop).
   * Pops the head and dispatches it through the runner if the queue is
   * eligible to fire — busy projects are eligible too: the registry's
   * `isRunning` flips off before this hook runs because the runner
   * detaches the process inside its onDone callback.
   */
  dispatchNext(projectName: string): void {
    const q = this.queues.get(projectName);
    if (!q || q.paused || q.items.length === 0) return;
    if (this.deps.registry.isRunning(projectName)) return;
    if (!this.dispatcher) return;

    const next = q.items[0];
    if (!next) return;
    const ok = this.dispatcher.dispatch(projectName, next.text, next);
    if (!ok) {
      // Dispatcher refused (no workspace, etc). Leave the item at the
      // head so the user can resume or remove it manually.
      return;
    }
    q.items.shift();
    this.persistAndNotify(projectName);
  }

  // ── Internals ────────────────────────────────────────────────────────
  private ensure(projectName: string): MutableQueue {
    let q = this.queues.get(projectName);
    if (!q) {
      q = { items: [], paused: false };
      this.queues.set(projectName, q);
    }
    return q;
  }

  private persistAndNotify(projectName: string): void {
    this.deps.repo.save(this.queues);
    const q = this.queues.get(projectName);
    this.notify({
      projectName,
      items: q ? q.items.map((it) => ({ ...it })) : [],
      paused: q ? q.paused : false,
    });
  }
}
