import * as fs from 'node:fs';
import * as path from 'node:path';

import type { KanbanStore } from '../kanban/infrastructure/kanban-store';

/**
 * Watches each project's `kanban.json` for out-of-process writes
 * (E-DSK-12 T5). The bundled devia-kanban MCP server runs as a
 * separate process spawned by the CLI agent; when it mutates the
 * board file this watcher invalidates the store cache and fires
 * `onChange` so the renderer re-fetches.
 *
 * We watch the parent directory (not the file) so creation of a
 * not-yet-existing board and the temp-file → rename swap both
 * register. Events are debounced — a rename storm collapses to one
 * refresh.
 */
const DEBOUNCE_MS = 150;

export class KanbanWatcher {
  private readonly watchers = new Map<string, fs.FSWatcher>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly store: KanbanStore,
    private readonly onChange: (projectPath: string) => void,
  ) {}

  /** Start watching a project (idempotent). */
  watch(projectPath: string): void {
    if (this.watchers.has(projectPath)) return;
    const file = this.store.fileFor(projectPath);
    const dir = path.dirname(file);
    const base = path.basename(file);
    try {
      fs.mkdirSync(dir, { recursive: true });
      const w = fs.watch(dir, (_event, filename) => {
        if (filename && filename.toString() !== base) return;
        this.schedule(projectPath);
      });
      this.watchers.set(projectPath, w);
    } catch {
      // Watching is best-effort; the renderer can still poll on demand.
    }
  }

  /** Stop watching one project (or every project when omitted). */
  unwatch(projectPath?: string): void {
    if (projectPath === undefined) {
      for (const [, w] of this.watchers) w.close();
      for (const [, t] of this.timers) clearTimeout(t);
      this.watchers.clear();
      this.timers.clear();
      return;
    }
    this.watchers.get(projectPath)?.close();
    this.watchers.delete(projectPath);
    const t = this.timers.get(projectPath);
    if (t) { clearTimeout(t); this.timers.delete(projectPath); }
  }

  private schedule(projectPath: string): void {
    const existing = this.timers.get(projectPath);
    if (existing) clearTimeout(existing);
    this.timers.set(
      projectPath,
      setTimeout(() => {
        this.timers.delete(projectPath);
        this.store.invalidate(projectPath);
        this.onChange(projectPath);
      }, DEBOUNCE_MS),
    );
  }
}
