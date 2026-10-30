import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  WorkspaceScanner,
  WorkspaceSearchHit,
  TechDetector,
} from '../domain/ports';
import type { ConfigRepository } from '../../../shared/ports';

// Folders that never contain user projects and would blow up a recursive
// walk (heavy and/or generated content). Skipped at every level, in addition
// to the user-configured ignoreFolders which only apply at the workspace
// root (matching listSubpath).
const HARD_SKIP_FOLDERS: ReadonlySet<string> = new Set([
  'node_modules', 'dist', 'build', 'target', 'out',
  '.git', '.svn', '.hg', '.idea', '.vscode', '.gradle',
  '.next', '.nuxt', '.cache', 'coverage', 'venv', '.venv', '__pycache__',
]);
const SEARCH_MAX_RESULTS = 200;
const SEARCH_MAX_DEPTH = 6;

export class FsWorkspaceScanner implements WorkspaceScanner {
  constructor(
    private readonly config: ConfigRepository,
    private readonly tech: TechDetector,
  ) {}

  /**
   * Resolves a subpath relative to workspaceRoot, refusing anything that
   * escapes it (e.g. "../etc"). Returns null if the resolved path is outside.
   */
  private resolveInsideWorkspace(subpath: string): string | null {
    const { workspaceRoot } = this.config.get();
    if (!workspaceRoot) return null;
    const root = path.resolve(workspaceRoot);
    const target = path.resolve(workspaceRoot, subpath || '');
    if (target !== root && !target.startsWith(root + path.sep)) return null;
    return target;
  }

  listSubpath(subpath: string): string[] {
    const dir = this.resolveInsideWorkspace(subpath);
    if (!dir) return [];
    const { ignoreFolders } = this.config.get();
    try {
      return fs.readdirSync(dir)
        .filter((name) => {
          if (name.startsWith('.')) return false;
          if (subpath === '' && ignoreFolders.includes(name)) return false;
          return fs.statSync(path.join(dir, name)).isDirectory();
        })
        .sort();
    } catch {
      return [];
    }
  }

  /**
   * Walks workspaceRoot recursively. Stops descending once detectTech
   * identifies a directory as a project — we assume projects don't nest
   * inside other projects in a vibe-coding workspace, which keeps the walk
   * cheap. ignoreFolders applies only at the root, mirroring listSubpath.
   */
  search(query: string): WorkspaceSearchHit[] {
    const { workspaceRoot, ignoreFolders } = this.config.get();
    if (!workspaceRoot) return [];
    const needle = String(query || '').trim().toLowerCase();
    if (!needle) return [];

    const rootSkip = new Set(Array.isArray(ignoreFolders) ? ignoreFolders : []);
    const results: WorkspaceSearchHit[] = [];

    const walk = (relPath: string, depth: number): void => {
      if (results.length >= SEARCH_MAX_RESULTS || depth > SEARCH_MAX_DEPTH) return;
      const abs = this.resolveInsideWorkspace(relPath);
      if (!abs) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(abs, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (results.length >= SEARCH_MAX_RESULTS) return;
        if (!entry.isDirectory()) continue;
        const name = entry.name;
        if (name.startsWith('.')) continue;
        if (HARD_SKIP_FOLDERS.has(name)) continue;
        if (relPath === '' && rootSkip.has(name)) continue;

        const childRel = relPath ? `${relPath}/${name}` : name;
        const tech = this.tech.detect(childRel);
        if (tech !== 'folder') {
          if (name.toLowerCase().includes(needle)) {
            results.push({ name, path: childRel, tech });
          }
          continue;
        }
        walk(childRel, depth + 1);
      }
    };

    walk('', 0);
    results.sort((a, b) => a.name.localeCompare(b.name));
    return results;
  }
}
