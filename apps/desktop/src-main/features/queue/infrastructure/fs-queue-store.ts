import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ConfigRepository } from '../../../shared/ports';
import type {
  QueueRepository,
  QueueRepositorySnapshot,
} from '../domain/ports';

interface PersistedQueueItem {
  id: string;
  text: string;
  createdAt: number;
  origin?: 'renderer' | 'remote';
}
interface PersistedProjectQueue {
  items: PersistedQueueItem[];
  paused: boolean;
}
interface PersistedQueues {
  version: 1;
  queues: Record<string, PersistedProjectQueue>;
}

/**
 * Durable storage for the per-project instruction queue.
 *
 * - Lives next to `state.json` in `~/.devia-app/` to follow the same
 *   single-folder-wipe pattern every other persisted concern uses.
 * - Writes are atomic (write to `queues.json.tmp`, then `rename` — POSIX
 *   guarantees rename is atomic within the same filesystem, so a crash
 *   mid-write never leaves a truncated file the next boot can't parse).
 * - Saves are debounced ~200ms so a burst of mutations (drag reorder,
 *   shift-on-process-end) collapses into one fsync.
 * - `load()` is synchronous: the composition root needs the queue
 *   visible before the renderer subscribes to queue:changed.
 */
export class FsQueueRepository implements QueueRepository {
  private static readonly DEBOUNCE_MS = 200;
  private static readonly FILE_NAME = 'queues.json';

  private pending: ReadonlyMap<string, QueueRepositorySnapshot> | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly config: ConfigRepository) {}

  private filePath(): string {
    return path.join(this.config.deviaDir(), FsQueueRepository.FILE_NAME);
  }

  load(): Map<string, QueueRepositorySnapshot> {
    const out = new Map<string, QueueRepositorySnapshot>();
    const file = this.filePath();
    if (!fs.existsSync(file)) return out;

    let parsed: Partial<PersistedQueues>;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<PersistedQueues>;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[queue] load failed (corrupt file, ignoring):', message);
      return out;
    }

    const queues = parsed.queues ?? {};
    for (const [projectName, raw] of Object.entries(queues)) {
      if (!raw || !Array.isArray(raw.items)) continue;
      const items = raw.items
        .filter((it): it is PersistedQueueItem =>
          !!it && typeof it.id === 'string' && typeof it.text === 'string',
        )
        .map((it) => ({
          id: it.id,
          text: it.text,
          createdAt: typeof it.createdAt === 'number' ? it.createdAt : Date.now(),
          ...(it.origin === 'remote' ? { origin: it.origin } : {}),
        }));
      out.set(projectName, {
        items,
        paused: !!raw.paused,
      });
    }
    return out;
  }

  save(state: ReadonlyMap<string, QueueRepositorySnapshot>): void {
    this.pending = state;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const snapshot = this.pending;
      this.pending = null;
      if (snapshot) this.writeNow(snapshot);
    }, FsQueueRepository.DEBOUNCE_MS);
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const snapshot = this.pending;
    this.pending = null;
    if (snapshot) this.writeNow(snapshot);
  }

  private writeNow(state: ReadonlyMap<string, QueueRepositorySnapshot>): void {
    const queues: Record<string, PersistedProjectQueue> = {};
    for (const [project, snap] of state) {
      // Skip empty + unpaused queues to keep the file tidy.
      if (snap.items.length === 0 && !snap.paused) continue;
      queues[project] = {
        items: snap.items.map((it) => ({
          id: it.id,
          text: it.text,
          createdAt: it.createdAt,
          ...(it.origin === 'remote' ? { origin: it.origin } : {}),
        })),
        paused: snap.paused,
      };
    }
    const payload: PersistedQueues = { version: 1, queues };

    const file = this.filePath();
    const tmp = `${file}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
      fs.renameSync(tmp, file);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[queue] save failed:', message);
      try { fs.unlinkSync(tmp); } catch { /* swallow */ }
    }
  }
}
