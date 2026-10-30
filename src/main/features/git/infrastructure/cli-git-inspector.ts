import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  execFileOnPath,
  execFileSyncOnPath,
} from '../../cli-adapters/infrastructure/path-command';
import type { ConfigRepository, GitInspector } from '../../../shared/ports';
import type {
  DiffFile,
  DiffLine,
  DiffResult,
  GitInfo,
} from '../../../../shared/domain/git';
import { parseUnifiedDiff } from './diff-parser';

// Cap any single file at this many lines so a giant generated artefact
// (lockfile, build output) can't freeze the UI.
const MAX_LINES_PER_FILE = 5000;
const MAX_BUFFER = 32 * 1024 * 1024;

export class CliGitInspector implements GitInspector {
  // Per-absolute-path cache of the resolved default branch. Populated lazily
  // by `warmDefaultBranch`, consumed synchronously by `info()`. Survives for
  // the lifetime of the main process — default branches change rarely enough
  // that a process restart is an acceptable refresh trigger.
  private readonly defaultBranchCache = new Map<string, string | null>();
  // De-dupe concurrent warmups for the same project so a fast project switch
  // doesn't spawn two `git ls-remote` calls.
  private readonly inflightWarmups = new Map<string, Promise<string | null>>();

  constructor(private readonly config: ConfigRepository) {}

  info(projectName: string): GitInfo | null {
    const { workspaceRoot } = this.config.get();
    if (!workspaceRoot) return null;
    // resolve (not join) so an absolute worktree path (S-13 split view, outside
    // workspaceRoot) is used as-is, while a workspace-relative name still
    // resolves under the workspace.
    const projectPath = path.resolve(workspaceRoot, projectName);
    if (!fs.existsSync(path.join(projectPath, '.git'))) return null;
    try {
      // HT-ST-02: a single `--porcelain=v2 --branch` walk yields branch
      // name, upstream ahead/behind AND the per-entry change list in one
      // call. Cheaper than three separate `git` invocations and
      // guaranteed-consistent (no race between branch read and dirty
      // check across user actions).
      const raw = execFileSyncOnPath('git', ['status', '--porcelain=v2', '--branch', '--untracked-files=all'], {
        cwd: projectPath, stdio: ['ignore', 'pipe', 'pipe'],
      }).toString();
      const parsed = parsePorcelainV2(raw);
      const cached = this.defaultBranchCache.get(projectPath);
      const defaultBranch = cached !== undefined ? cached : detectDefaultBranchLocal(projectPath);
      return {
        branch: parsed.branch,
        dirty: parsed.changedCount > 0,
        defaultBranch,
        ahead: parsed.ahead,
        behind: parsed.behind,
        changedCount: parsed.changedCount,
      };
    } catch {
      return null;
    }
  }

  async asyncDiff(projectPath: string): Promise<DiffResult> {
    const { workspaceRoot } = this.config.get();
    if (!workspaceRoot) return { hasChanges: false, files: [] };

    const cwd = path.resolve(workspaceRoot, projectPath);
    if (!fs.existsSync(path.join(cwd, '.git'))) {
      return { hasChanges: false, files: [], reason: 'not-a-git-repo' };
    }

    const files: DiffFile[] = [];

    // Tracked changes vs HEAD (staged + unstaged).
    let trackedDiff = '';
    try {
      const { stdout } = await execFileOnPath(
        'git', ['diff', 'HEAD', '--no-color'],
        { cwd, maxBuffer: MAX_BUFFER },
      );
      trackedDiff = stdout;
    } catch {
      try {
        const { stdout } = await execFileOnPath(
          'git', ['diff', '--no-color'],
          { cwd, maxBuffer: MAX_BUFFER },
        );
        trackedDiff = stdout;
      } catch {
        /* leave empty */
      }
    }
    files.push(...parseUnifiedDiff(trackedDiff, MAX_LINES_PER_FILE));

    // Untracked files don't show up in `git diff`.
    let untracked: string[] = [];
    try {
      const { stdout } = await execFileOnPath(
        'git', ['ls-files', '--others', '--exclude-standard'],
        { cwd, maxBuffer: MAX_BUFFER },
      );
      untracked = stdout.split('\n').filter(Boolean);
    } catch {
      /* ignore */
    }

    for (const rel of untracked) {
      const abs = path.join(cwd, rel);
      let content = '';
      try {
        const stat = fs.statSync(abs);
        if (!stat.isFile()) continue;
        if (stat.size > 1024 * 1024) {
          files.push({
            path: rel, status: 'added',
            lines: [{ type: 'hunk', text: `(${(stat.size / 1024).toFixed(0)} KB — sin previsualización)` }],
          });
          continue;
        }
        content = fs.readFileSync(abs, 'utf8');
      } catch {
        continue;
      }
      if (content.includes('\0')) {
        files.push({
          path: rel, status: 'added',
          lines: [{ type: 'hunk', text: '(binary file)' }],
        });
        continue;
      }
      const rawLines = content.split('\n');
      const lines: DiffLine[] = rawLines.slice(0, MAX_LINES_PER_FILE).map((text, i) => ({
        type: 'add', newLineNo: i + 1, text,
      }));
      if (rawLines.length > MAX_LINES_PER_FILE) {
        lines.push({ type: 'hunk', text: `(${rawLines.length - MAX_LINES_PER_FILE} líneas más, recortado)` });
      }
      files.push({ path: rel, status: 'added', lines });
    }

    return { hasChanges: files.length > 0, files };
  }

  /**
   * S-3 F1.2: synchronous default-branch read for worktree creation. Serves
   * the warm cache first (the gitWatch path warms it, remote fallback
   * included), then a local-only probe — NEVER the network, so creating a
   * worktree stays fast and offline-safe. Only truthy results are cached
   * here, leaving the remote warm-up path available for later.
   */
  defaultBranchSync(projectName: string): string | null {
    const { workspaceRoot } = this.config.get();
    if (!workspaceRoot) return null;
    const projectPath = path.resolve(workspaceRoot, projectName);
    if (!fs.existsSync(path.join(projectPath, '.git'))) return null;
    const cached = this.defaultBranchCache.get(projectPath);
    if (cached !== undefined) return cached;
    const local = detectDefaultBranchLocal(projectPath);
    if (local) this.defaultBranchCache.set(projectPath, local);
    return local;
  }

  async warmDefaultBranch(projectName: string): Promise<string | null> {
    const { workspaceRoot } = this.config.get();
    if (!workspaceRoot) return null;
    // resolve (not join) so an absolute worktree path (S-13 split view, outside
    // workspaceRoot) is used as-is, while a workspace-relative name still
    // resolves under the workspace.
    const projectPath = path.resolve(workspaceRoot, projectName);
    if (!fs.existsSync(path.join(projectPath, '.git'))) return null;

    const cached = this.defaultBranchCache.get(projectPath);
    if (cached) return cached;

    const inflight = this.inflightWarmups.get(projectPath);
    if (inflight) return inflight;

    const work = (async (): Promise<string | null> => {
      const local = detectDefaultBranchLocal(projectPath);
      if (local) {
        this.defaultBranchCache.set(projectPath, local);
        return local;
      }
      const remote = await detectDefaultBranchRemote(projectPath);
      // Cache the null result too: avoids hammering the network on repos
      // without an origin remote. The cache is cleared on process restart,
      // which is the natural retry trigger.
      this.defaultBranchCache.set(projectPath, remote);
      return remote;
    })().finally(() => this.inflightWarmups.delete(projectPath));

    this.inflightWarmups.set(projectPath, work);
    return work;
  }

  diff(projectPath: string): DiffResult {
    const { workspaceRoot } = this.config.get();
    if (!workspaceRoot) return { hasChanges: false, files: [] };

    const cwd = path.resolve(workspaceRoot, projectPath);
    if (!fs.existsSync(path.join(cwd, '.git'))) {
      return { hasChanges: false, files: [], reason: 'not-a-git-repo' };
    }

    const files: DiffFile[] = [];

    // Tracked changes vs HEAD (staged + unstaged). Falls back to diffing
    // against the empty tree if HEAD doesn't exist (no commits yet).
    let trackedDiff = '';
    try {
      trackedDiff = execFileSyncOnPath('git', ['diff', 'HEAD', '--no-color'], {
        cwd, maxBuffer: MAX_BUFFER, stdio: ['ignore', 'pipe', 'pipe'],
      }).toString();
    } catch {
      try {
        trackedDiff = execFileSyncOnPath('git', ['diff', '--no-color'], {
          cwd, maxBuffer: MAX_BUFFER, stdio: ['ignore', 'pipe', 'pipe'],
        }).toString();
      } catch {
        /* leave empty */
      }
    }
    files.push(...parseUnifiedDiff(trackedDiff, MAX_LINES_PER_FILE));

    // Untracked files don't show up in `git diff`. Pick them up here and
    // synthesize an "all-additions" diff so the user sees their content.
    let untracked: string[] = [];
    try {
      untracked = execFileSyncOnPath('git', ['ls-files', '--others', '--exclude-standard'], {
        cwd, maxBuffer: MAX_BUFFER, stdio: ['ignore', 'pipe', 'pipe'],
      }).toString().split('\n').filter(Boolean);
    } catch {
      /* ignore */
    }

    for (const rel of untracked) {
      const abs = path.join(cwd, rel);
      let content = '';
      try {
        const stat = fs.statSync(abs);
        if (!stat.isFile()) continue;
        if (stat.size > 1024 * 1024) {
          files.push({
            path: rel, status: 'added',
            lines: [{ type: 'hunk', text: `(${(stat.size / 1024).toFixed(0)} KB — sin previsualización)` }],
          });
          continue;
        }
        content = fs.readFileSync(abs, 'utf8');
      } catch {
        continue;
      }
      if (content.includes('\0')) {
        files.push({
          path: rel, status: 'added',
          lines: [{ type: 'hunk', text: '(binary file)' }],
        });
        continue;
      }
      const rawLines = content.split('\n');
      const lines: DiffLine[] = rawLines.slice(0, MAX_LINES_PER_FILE).map((text, i) => ({
        type: 'add', newLineNo: i + 1, text,
      }));
      if (rawLines.length > MAX_LINES_PER_FILE) {
        lines.push({ type: 'hunk', text: `(${rawLines.length - MAX_LINES_PER_FILE} líneas más, recortado)` });
      }
      files.push({ path: rel, status: 'added', lines });
    }

    return { hasChanges: files.length > 0, files };
  }
}

// Local-only default-branch detection. Reads `refs/remotes/origin/HEAD` which
// `git clone` sets up automatically. `git init` + `git remote add origin`
// flows leave this unset, hence the async `warmDefaultBranch` remote fallback.
export function detectDefaultBranchLocal(cwd: string): string | null {
  try {
    const out = execFileSyncOnPath('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], {
      cwd, stdio: ['ignore', 'pipe', 'pipe'],
    }).toString().trim();
    if (out.startsWith('origin/')) return out.slice('origin/'.length);
    return null;
  } catch {
    return null;
  }
}

// Remote fallback: queries origin without a full fetch. Async + network, so
// only used from `warmDefaultBranch` to seed the cache (never the hot path).
async function detectDefaultBranchRemote(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileOnPath(
      'git', ['ls-remote', '--symref', 'origin', 'HEAD'],
      { cwd },
    );
    const match = stdout.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD/m);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * `git status --porcelain=v2 --branch` returns a stream of header lines
 * (`# branch.head <name>`, `# branch.ab +<ahead> -<behind>`, …) followed
 * by per-entry lines (`1`, `2`, `?`, `!`). We only need three counters
 * out of it; everything else is ignored.
 *
 * - `branch.head` → current branch (`(detached)` when HEAD is detached).
 * - `branch.ab`   → present only when an upstream is configured;
 *                   missing → ahead = behind = 0.
 * - entry lines   → count anything that's NOT a header / blank / `!`
 *                   (ignored file). `?` (untracked) DOES count.
 *
 * Exported so the unit tests can hit the parser without spawning git.
 */
export interface PorcelainV2Summary {
  branch: string;
  ahead: number;
  behind: number;
  changedCount: number;
}

export function parsePorcelainV2(raw: string): PorcelainV2Summary {
  let branch = '';
  let ahead = 0;
  let behind = 0;
  let changedCount = 0;
  for (const line of raw.split('\n')) {
    if (!line) continue;
    if (line.startsWith('# branch.head ')) {
      branch = line.slice('# branch.head '.length).trim();
      continue;
    }
    if (line.startsWith('# branch.ab ')) {
      const m = /^# branch\.ab \+(\d+) -(\d+)/.exec(line);
      if (m && m[1] !== undefined && m[2] !== undefined) {
        ahead = Number.parseInt(m[1], 10);
        behind = Number.parseInt(m[2], 10);
      }
      continue;
    }
    if (line.startsWith('#')) continue;
    // Skip ignored entries (`!`) — they aren't "changes" the user has
    // to deal with. Everything else (1, 2, u, ?) counts as one change.
    if (line.startsWith('! ')) continue;
    changedCount += 1;
  }
  return { branch, ahead, behind, changedCount };
}
