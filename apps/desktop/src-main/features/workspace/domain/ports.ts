import type { ProjectTech } from '../../../../shared/domain/project';
import type { BasesMap } from '../../../../shared/domain/base';

/**
 * Resolves project listings under the configured `workspaceRoot`. Two
 * surfaces:
 *   - `listSubpath(rel)`  → direct children of a single folder, sorted.
 *   - `search(query)`     → workspace-wide recursive substring match.
 * Both refuse anything that escapes the workspace root.
 */
export interface WorkspaceScanner {
  listSubpath(subpath: string): string[];
  search(query: string): WorkspaceSearchHit[];
}

export interface WorkspaceSearchHit {
  name: string;
  path: string;
  tech: ProjectTech;
}

/**
 * Detects the tech stack of a project by looking for canonical config files.
 * First match wins. If no marker matches, a `.git` directory still counts
 * (e.g. markdown skill libraries, docs repos) — those get the 'git' tag and
 * are selectable in the sidebar instead of being treated as navigable folders.
 */
export interface TechDetector {
  detect(projectPath: string): ProjectTech;
}

/**
 * Wraps Electron's `dialog.showOpenDialog`. Behind a port so the use-case
 * layer stays Electron-agnostic and can be exercised without a window.
 */
export interface DialogService {
  pickFolder(opts?: { title?: string; defaultPath?: string }): Promise<string | null>;
  pickFile(opts?: {
    title?: string;
    defaultPath?: string;
    filters?: Array<{ name: string; extensions: string[] }>;
  }): Promise<string | null>;
}

/**
 * Persistence for the user's project bases. Backed by a JSON file in the
 * devia config dir; behind a port so the use cases stay decoupled from disk.
 *
 * `readText` returns the raw on-disk text (so the renderer's JSON editor can
 * show the exact file content, including formatting) while `read` returns the
 * parsed map (falling back to {} on missing/invalid). `writeText` validates
 * the input parses as JSON before touching disk.
 */
export interface BasesStore {
  read(): BasesMap;
  readText(): string;
  writeText(text: string): BasesMap;
  filePath(): string;
}

/**
 * Filesystem-level operations used by the workspace use cases. Behind a
 * port so the use cases don't pull `fs`/`child_process` directly — handy
 * for unit testing the cascading rules in trash/rename.
 */
export interface ProjectFileSystem {
  exists(absPath: string): boolean;
  mkdirRecursive(absPath: string): void;
  rename(absFrom: string, absTo: string): void;
  rmRecursive(absPath: string): void;
  /** Copies a directory tree without preserving the source `.git/`. */
  copyTreeWithoutGit(absFrom: string, absTo: string): void;
  /**
   * Clones a git repository into `absTo`, then strips its `.git/` and runs a
   * fresh `git init` so the new project owns its own history. Throws on any
   * failure — caller decides what to do with the (now possibly partial) dir.
   */
  gitCloneAndReinit(repository: string, absTo: string): void;
  /**
   * Applies a single overlay entry from a base. `absProjectRoot` is the new
   * project's path; `entry.to` resolves relative to it. Returns true when the
   * source existed and the copy ran; false when the source was missing
   * (silently skipped, mirroring agent-controler's behaviour).
   */
  applyBaseCopyEntry(
    absProjectRoot: string,
    entry: { from: string; to: string; exclude?: string[]; flatten?: boolean },
  ): boolean;
  /** Runs `git init` and creates the first commit. Swallows errors so a
   *  workspace without git installed still gets the directory created. */
  gitInit(absPath: string): void;
  gitInitAndFirstCommit(absPath: string, message: string): void;
  /**
   * Writes the per-agent initial config for a freshly-created project so
   * every compatible agent can run there without manual setup: Claude's
   * `.claude/settings.local.json` permissions baseline (+ `.gitignore`
   * entry) and Codex's trusted-project entry in the global codex config.
   * Idempotent per agent — existing files/entries are never overwritten.
   */
  ensureAgentDefaults(absPath: string): void;
  /** Move to OS trash. */
  trash(absPath: string): Promise<void>;
}
