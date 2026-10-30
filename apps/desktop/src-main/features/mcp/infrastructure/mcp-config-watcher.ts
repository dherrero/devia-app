import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Watches `<deviaDir>/mcp-servers.json` for out-of-process edits (#274):
 * a hand-edit, or an external tool writing the registry file while Devia is
 * running. Without it the in-memory registry only reloads on startup or on an
 * install/remove from the manager, so a hand-edit never reached the badge or
 * the MCP manager until a restart.
 *
 * Mirrors `KanbanWatcher`: we watch the parent directory (not the file) so the
 * temp-file → rename swap our own atomic writer uses still registers, filter by
 * basename, and debounce a rename storm into a single `onChange`.
 *
 * A SINGLE global watcher regardless of how many projects the workspace holds:
 * the runtime registry mirrors only this one global file — project-scope
 * servers live in each project's `.mcp.json` and never enter the registry — so
 * per-project watchers would add cost without changing the count. One fixed
 * handle also keeps us clear of inotify descriptor limits on Linux.
 */
const DEBOUNCE_MS = 150;

export class McpConfigWatcher {
  private watcher: fs.FSWatcher | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly fileFor: () => string,
    private readonly onChange: () => void,
  ) {}

  /** Start watching (idempotent, best-effort). */
  start(): void {
    if (this.watcher) return;
    const file = this.fileFor();
    const dir = path.dirname(file);
    const base = path.basename(file);
    try {
      fs.mkdirSync(dir, { recursive: true });
      this.watcher = fs.watch(dir, (_event, filename) => {
        if (filename && filename.toString() !== base) return;
        this.schedule();
      });
    } catch {
      // Best-effort: the registry still loads at register() and refreshes on
      // install/remove; the renderer can rescan on demand.
    }
  }

  /** Stop watching and cancel any pending debounce (idempotent). */
  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.watcher) {
      try { this.watcher.close(); } catch { /* swallow */ }
      this.watcher = null;
    }
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.onChange();
    }, DEBOUNCE_MS);
  }
}
