import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';

import type { ConfigRepository } from '../../../shared/ports';
import type {
  ProjectTreeNode,
  ProjectTreeResult,
  ProjectTreeStatus,
} from '../../../../shared/domain/project-tree';
import type { ListOptions, ProjectTreeReader } from '../domain/ports';

const execFileAsync = promisify(execFile);

// Two git outputs are needed per listing: one for which entries are dirty
// (status) and one for which entries are gitignored (so we hide them by
// default — VSCode-style: node_modules/dist/build never clutter the view).
// They are stable for ~hundreds of ms; cache so back-to-back `list()` calls
// from expanding several sibling folders don't fan out into multiple git
// invocations.
const CACHE_TTL_MS = 500;

interface ProjectStatusSnapshot {
  /** path → status code. Paths are forward-slash, relative to project root.
   *  Includes only non-clean entries. */
  status: Map<string, ProjectTreeStatus>;
  /** Set of paths git considers ignored; whole-directory entries end with
   *  a trailing slash (e.g. "node_modules/"). */
  ignored: Set<string>;
  /** True when the project is not a git repo. status/ignored are empty. */
  gitless: boolean;
}

interface CacheEntry {
  ts: number;
  snapshot: ProjectStatusSnapshot;
}

export class FsProjectTreeReader implements ProjectTreeReader {
  private readonly cache = new Map<string, CacheEntry>();
  // De-dupes concurrent snapshot requests for the same project so a UI
  // refresh that triggers N parallel list() calls only spawns git once.
  private readonly inflight = new Map<string, Promise<ProjectStatusSnapshot>>();

  constructor(private readonly config: ConfigRepository) {}

  async list(
    projectName: string,
    subPath = '',
    opts: ListOptions = {},
  ): Promise<ProjectTreeResult> {
    const { workspaceRoot } = this.config.get();
    if (!workspaceRoot) {
      return { subPath: '', children: [], gitless: true };
    }

    const projectRoot = path.resolve(workspaceRoot, projectName);
    if (opts.force) this.cache.delete(projectRoot);
    const normalizedSub = normalizeSubPath(subPath);
    const absSub = normalizedSub
      ? path.join(projectRoot, normalizedSub)
      : projectRoot;

    // Guard against `..` traversal — normalizedSub is already stripped of
    // leading slashes, but a caller could still pass "../etc/passwd".
    if (!isInside(projectRoot, absSub)) {
      return { subPath: '', children: [], gitless: false };
    }

    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(absSub, { withFileTypes: true });
    } catch {
      return { subPath: normalizedSub, children: [], gitless: false };
    }

    const snapshot = await this.snapshot(projectRoot);

    const children: ProjectTreeNode[] = [];
    for (const entry of entries) {
      // .git is always hidden — there's nothing useful for the user inside.
      if (entry.name === '.git') continue;

      const rel = normalizedSub ? `${normalizedSub}/${entry.name}` : entry.name;
      const isDir = entry.isDirectory();
      const ignoredKey = isDir ? `${rel}/` : rel;
      if (snapshot.ignored.has(ignoredKey)) continue;

      const status = snapshot.status.get(rel);
      const node: ProjectTreeNode = {
        name: entry.name,
        path: rel,
        isDir,
        ...(status ? { status } : {}),
      };
      if (isDir) {
        node.hasChanges = hasNestedChanges(snapshot.status, rel);
      }
      children.push(node);
    }

    children.sort(compareNodes);
    return {
      subPath: normalizedSub,
      children,
      ...(snapshot.gitless ? { gitless: true } : {}),
    };
  }

  /** Drops any cached status snapshot for a project. Called by the git
   *  watcher hook so the very next list() reflects fresh state instead of
   *  a stale 500ms-old cache. */
  invalidate(projectName: string): void {
    const { workspaceRoot } = this.config.get();
    if (!workspaceRoot) return;
    const projectRoot = path.resolve(workspaceRoot, projectName);
    this.cache.delete(projectRoot);
  }

  private async snapshot(projectRoot: string): Promise<ProjectStatusSnapshot> {
    const cached = this.cache.get(projectRoot);
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.snapshot;

    const inflight = this.inflight.get(projectRoot);
    if (inflight) return inflight;

    const work = (async (): Promise<ProjectStatusSnapshot> => {
      if (!fs.existsSync(path.join(projectRoot, '.git'))) {
        return {
          status: new Map<string, ProjectTreeStatus>(),
          ignored: new Set<string>(),
          gitless: true,
        };
      }
      const [status, ignored] = await Promise.all([
        readStatus(projectRoot),
        readIgnored(projectRoot),
      ]);
      return { status, ignored, gitless: false };
    })().finally(() => this.inflight.delete(projectRoot));

    this.inflight.set(projectRoot, work);
    const snapshot = await work;
    this.cache.set(projectRoot, { ts: Date.now(), snapshot });
    return snapshot;
  }
}

function normalizeSubPath(subPath: string): string {
  return subPath
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
}

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

function compareNodes(a: ProjectTreeNode, b: ProjectTreeNode): number {
  if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
}

function hasNestedChanges(
  status: Map<string, ProjectTreeStatus>,
  folderPath: string,
): boolean {
  const prefix = `${folderPath}/`;
  for (const key of status.keys()) {
    if (key.startsWith(prefix)) return true;
  }
  return false;
}

async function readStatus(cwd: string): Promise<Map<string, ProjectTreeStatus>> {
  const map = new Map<string, ProjectTreeStatus>();
  let stdout = '';
  try {
    ({ stdout } = await execFileAsync(
      'git',
      ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
      { cwd, maxBuffer: 32 * 1024 * 1024 },
    ));
  } catch {
    return map;
  }

  // -z output is NUL-delimited; renames span two records (old<NUL>new).
  const records = stdout.split('\0');
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record || record.length < 3) continue;
    // Format: "XY path" where XY are the index + worktree status codes.
    const x = record.charAt(0);
    const y = record.charAt(1);
    const filePath = record.slice(3);
    const status = mapStatus(x, y);
    if (!status) continue;
    if (x === 'R' || y === 'R') {
      // Renames consume the next record as the original path; we annotate
      // the new path (what the user sees in the tree).
      map.set(filePath, status);
      i += 1;
      continue;
    }
    map.set(filePath, status);
  }
  return map;
}

function mapStatus(x: string, y: string): ProjectTreeStatus | null {
  if (x === '?' && y === '?') return 'untracked';
  if (x === 'A' || y === 'A') return 'added';
  if (x === 'D' || y === 'D') return 'deleted';
  if (x === 'R' || y === 'R') return 'renamed';
  if (x === 'M' || y === 'M') return 'modified';
  // Anything else (copied, unmerged, type-change) falls back to modified
  // so the user still sees the file is dirty.
  if (x !== ' ' || y !== ' ') return 'modified';
  return null;
}

async function readIgnored(cwd: string): Promise<Set<string>> {
  const set = new Set<string>();
  let stdout = '';
  try {
    ({ stdout } = await execFileAsync(
      'git',
      [
        'ls-files',
        '--others',
        '--ignored',
        '--exclude-standard',
        '--directory',
        '-z',
      ],
      { cwd, maxBuffer: 32 * 1024 * 1024 },
    ));
  } catch {
    return set;
  }
  for (const entry of stdout.split('\0')) {
    if (entry) set.add(entry);
  }
  return set;
}
