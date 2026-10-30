import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as pty from 'node-pty';
import type { IPty } from 'node-pty';
import type { ConfigRepository } from '../../../shared/ports';
import type { PtyExitInfo, PtySize, PtyStartResult } from '../domain/types';

interface PtyEntry {
  child: IPty;
  cwd: string;
  shell: string;
}

export interface PtyHooks {
  onData(chunk: string): void;
  onExit(info: PtyExitInfo): void;
}

/**
 * One PTY per project. The pty survives the renderer hiding the terminal panel
 * (the Angular component may be display:none or destroyed entirely on tab
 * switches) — it only goes away when the user explicitly stops it or when the
 * shell process exits. That way every project keeps its own scrollback and
 * cwd between visits.
 */
export class PtyManager {
  private readonly ptys = new Map<string, PtyEntry>();

  // Resolved at use-time from the config repo — the user can switch workspaces
  // at runtime (workspace modal) and we want subsequent PTYs to honour the new
  // root. Every other feature does the same thing (claude-runner, compose,
  // git, sessions); we copy that convention.
  constructor(private readonly config: ConfigRepository) {}

  start(projectPath: string, size: Partial<PtySize>, hooks: PtyHooks): PtyStartResult {
    if (!projectPath || typeof projectPath !== 'string') {
      throw new Error('PtyManager.start: projectPath is required');
    }
    const existing = this.ptys.get(projectPath);
    if (existing) {
      return {
        pid: existing.child.pid,
        cwd: existing.cwd,
        shell: existing.shell,
        reused: true,
      };
    }

    const cwd = this.resolveCwd(projectPath);
    const shell = defaultShell();
    const cols = clamp(size.cols, 2, 1000, 80);
    const rows = clamp(size.rows, 1, 500, 24);

    const child = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        LANG: process.env['LANG'] ?? 'en_US.UTF-8',
      },
    });

    const entry: PtyEntry = { child, cwd, shell };
    this.ptys.set(projectPath, entry);

    child.onData((data) => hooks.onData(data));
    child.onExit(({ exitCode, signal }) => {
      this.ptys.delete(projectPath);
      hooks.onExit({ code: exitCode ?? 0, signal: signal ?? 0 });
    });

    return { pid: child.pid, cwd, shell, reused: false };
  }

  write(projectPath: string, data: string): boolean {
    const entry = this.ptys.get(projectPath);
    if (!entry) return false;
    entry.child.write(data);
    return true;
  }

  resize(projectPath: string, size: Partial<PtySize>): boolean {
    const entry = this.ptys.get(projectPath);
    if (!entry) return false;
    const cols = clamp(size.cols, 2, 1000, 80);
    const rows = clamp(size.rows, 1, 500, 24);
    try {
      entry.child.resize(cols, rows);
    } catch {
      // node-pty throws if the process already exited. Treat as no-op.
    }
    return true;
  }

  stop(projectPath: string): boolean {
    const entry = this.ptys.get(projectPath);
    if (!entry) return false;
    try {
      entry.child.kill();
    } catch {
      /* already exited */
    }
    this.ptys.delete(projectPath);
    return true;
  }

  stopAll(): string[] {
    const stopped: string[] = [];
    for (const projectPath of Array.from(this.ptys.keys())) {
      if (this.stop(projectPath)) stopped.push(projectPath);
    }
    return stopped;
  }

  /**
   * Resolve the absolute working directory for a project string. The
   * renderer hands us workspace-relative names (the same convention every
   * other feature follows — claude-runner, compose, git all do
   * path.join(workspaceRoot, projectName)). We tolerate absolute paths too
   * for forward-compatibility, but the primary case is the relative name.
   * Falls back to HOME only when the workspace is unconfigured.
   */
  private resolveCwd(projectPath: string): string {
    if (path.isAbsolute(projectPath) && isDirectory(projectPath)) {
      return projectPath;
    }
    const root = this.config.get().workspaceRoot;
    if (root) {
      const candidate = path.join(root, projectPath);
      if (isDirectory(candidate)) return candidate;
      if (isDirectory(root)) return root;
    }
    return os.homedir();
  }
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function defaultShell(): string {
  if (process.platform === 'win32') {
    return process.env['COMSPEC'] ?? 'powershell.exe';
  }
  return process.env['SHELL'] ?? '/bin/bash';
}

function clamp(value: number | undefined, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}
