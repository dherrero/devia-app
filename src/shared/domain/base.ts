/**
 * Project base — a template for creating new projects. Stored in
 * ~/.devia-app/bases.json and edited from the renderer via a JSON editor.
 *
 * Mirror of the original `ProjectBase` shape in `agent-controler/src/types.ts`,
 * with all three fields optional so a base can be:
 *   - pure-git (just `repository`),
 *   - pure-overlay (just `copy_from_folder`, starts from an empty git repo),
 *   - or any combination, optionally followed by an `autoSetup` instruction
 *     that gets sent to the active CLI agent right after the project is created.
 */
export interface BaseCopyEntry {
  /** Source path. Supports `~/` expansion. Can be a file or a directory. */
  from: string;
  /** Destination, relative to the newly created project root. */
  to: string;
  /** Paths (relative to `to`) to delete after the copy completes. */
  exclude?: string[];
  /** When true, copies the contents of `from` into `to` instead of nesting. */
  flatten?: boolean;
}

export interface ProjectBase {
  /** Git URL to clone. Cleared and re-initialised so the new project owns its history. */
  repository?: string;
  /** Files/folders overlayed on top of the cloned (or empty) project. */
  copy_from_folder?: BaseCopyEntry[];
  /** Instruction sent to the active CLI agent in the new project after creation. */
  autoSetup?: string;
}

export type BasesMap = Record<string, ProjectBase>;

/**
 * Outcome of creating a project from a base. The renderer uses `autoSetup` to
 * dispatch the post-creation instruction so the result also surfaces in the
 * chat panel — keeping the use case free of any UI concerns.
 */
export interface NewFromBaseResult {
  projectPath: string;
  autoSetup?: string;
}
