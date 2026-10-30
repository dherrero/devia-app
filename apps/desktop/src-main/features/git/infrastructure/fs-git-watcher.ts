import * as fs from 'node:fs';
import * as path from 'node:path';
import type { GitWatcher, GitWatchListener } from '../domain/ports';
import type { ConfigRepository, GitInspector } from '../../../shared/ports';

const DEBOUNCE_MS = 150;

interface WatchState {
  projectPath: string;
  watchers: fs.FSWatcher[];
  debounceTimer: NodeJS.Timeout | null;
  listener: GitWatchListener;
  lastSerialized: string | null;
}

/**
 * Watches `<project>/.git/HEAD`, `index` and `refs/heads/` (recursive) with
 * native `fs.watch`. Coalesces bursts with a 150 ms debounce, then re-reads
 * `inspector.info()` and notifies the listener if the serialized snapshot
 * has changed.
 *
 * `recursive: true` is reliable on macOS and Windows; on Linux it is
 * best-effort per the Node docs but git's burst pattern means HEAD/index
 * events still fire.
 */
export class FsGitWatcher implements GitWatcher {
  private current: WatchState | null = null;

  constructor(
    private readonly config: ConfigRepository,
    private readonly inspector: GitInspector,
  ) {}

  stop(): void {
    if (!this.current) return;
    if (this.current.debounceTimer) clearTimeout(this.current.debounceTimer);
    for (const w of this.current.watchers) {
      try { w.close(); } catch { /* swallow */ }
    }
    this.current = null;
  }

  private emitIfChanged(): void {
    if (!this.current) return;
    const info = this.inspector.info(this.current.projectPath);
    const serialized = info ? `${info.branch}|${info.dirty ? 1 : 0}|${info.defaultBranch ?? ''}` : 'null';
    if (serialized === this.current.lastSerialized) return;
    this.current.lastSerialized = serialized;
    this.current.listener({ projectPath: this.current.projectPath, info });
  }

  private scheduleEmit(): void {
    if (!this.current) return;
    if (this.current.debounceTimer) clearTimeout(this.current.debounceTimer);
    this.current.debounceTimer = setTimeout(() => {
      if (this.current) this.current.debounceTimer = null;
      this.emitIfChanged();
    }, DEBOUNCE_MS);
  }

  start(projectPath: string, listener: GitWatchListener): void {
    this.stop();
    if (!projectPath) return;
    const { workspaceRoot } = this.config.get();
    if (!workspaceRoot) return;

    // resolve (not join) so an absolute worktree path (S-13 split view) is
    // watched as-is; a relative project name still resolves under the workspace.
    const gitDir = path.join(path.resolve(workspaceRoot, projectPath), '.git');
    if (!fs.existsSync(gitDir)) return;

    const watchers: fs.FSWatcher[] = [];
    const safeWatch = (target: string, opts: fs.WatchOptions = {}): void => {
      try {
        if (!fs.existsSync(target)) return;
        const w = fs.watch(target, opts, () => this.scheduleEmit());
        w.on('error', () => { /* watcher errors must never crash the app */ });
        watchers.push(w);
      } catch {
        /* falls back to on-demand refresh */
      }
    };

    safeWatch(path.join(gitDir, 'HEAD'));
    safeWatch(path.join(gitDir, 'index'));
    safeWatch(path.join(gitDir, 'refs', 'heads'), { recursive: true });

    const initial = this.inspector.info(projectPath);
    this.current = {
      projectPath,
      watchers,
      debounceTimer: null,
      listener,
      lastSerialized: initial ? `${initial.branch}|${initial.dirty ? 1 : 0}` : 'null',
    };
  }

  refresh(): void {
    if (!this.current) return;
    if (this.current.debounceTimer) {
      clearTimeout(this.current.debounceTimer);
      this.current.debounceTimer = null;
    }
    this.emitIfChanged();
  }
}
