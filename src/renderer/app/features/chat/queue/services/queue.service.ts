import { Injectable, computed, inject, signal } from '@angular/core';
import { ElectronApiService } from '../../../../core/services/electron-api.service';
import type {
  ProjectQueueView,
  QueueChangedEvent,
  QueueItem,
} from '../../../../../types/devia';

/**
 * Renderer-side mirror of the per-project queue.
 *
 * The main process is the single source of truth — every mutation here
 * round-trips through IPC. We keep a local Map<project, view> only to
 * survive the latency between subscribing on init and the first
 * `queue:changed` event for a project: on first selection we eagerly
 * call `listQueue` so the panel paints without flicker.
 */
@Injectable({ providedIn: 'root' })
export class QueueService {
  private readonly api = inject(ElectronApiService);

  private readonly queues = signal<Map<string, ProjectQueueView>>(new Map());
  private readonly hydrated = new Set<string>();
  private wired = false;

  /** Boots the renderer-side listener. Idempotent. */
  init(): void {
    if (this.wired) return;
    this.wired = true;
    this.api.onQueueChanged((e: QueueChangedEvent) => {
      const next = new Map(this.queues());
      next.set(e.projectName, { items: e.items, paused: e.paused });
      this.queues.set(next);
      this.hydrated.add(e.projectName);
    });
  }

  /** Returns a project-scoped accessor that components can use directly. */
  selector(project: () => string | null) {
    return {
      view: computed<ProjectQueueView>(() => {
        const p = project();
        if (!p) return { items: [], paused: false };
        return this.queues().get(p) ?? { items: [], paused: false };
      }),
    };
  }

  /** Reads the current snapshot for `project` from main on first access. */
  async ensureHydrated(project: string): Promise<void> {
    if (this.hydrated.has(project)) return;
    try {
      const view = await this.api.listQueue(project);
      const next = new Map(this.queues());
      next.set(project, view);
      this.queues.set(next);
      this.hydrated.add(project);
    } catch (err) {
      console.error('[queue] hydrate failed:', err);
    }
  }

  // ── Mutations: every method returns the latest server-confirmed view
  //    via the existing queue:changed listener; callers don't need to
  //    touch the local Map. ────────────────────────────────────────────
  add(project: string, text: string): Promise<QueueItem> {
    return this.api.addToQueue(project, text);
  }
  remove(project: string, id: string): Promise<boolean> {
    return this.api.removeFromQueue(project, id);
  }
  edit(project: string, id: string, text: string): Promise<boolean> {
    return this.api.editInQueue(project, id, text);
  }
  move(project: string, id: string, newIndex: number): Promise<boolean> {
    return this.api.moveInQueue(project, id, newIndex);
  }
  clear(project: string): Promise<boolean> {
    return this.api.clearQueue(project);
  }
  pause(project: string): Promise<boolean> {
    return this.api.pauseQueue(project);
  }
  resume(project: string): Promise<boolean> {
    return this.api.resumeQueue(project);
  }
}
