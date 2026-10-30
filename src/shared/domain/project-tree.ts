export type ProjectTreeStatus =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'untracked';

export interface ProjectTreeNode {
  /** Base name only — e.g. "main.ts". */
  name: string;
  /** Path relative to the project root, forward slashes. Empty string for
   *  the root itself; never starts with a slash. */
  path: string;
  isDir: boolean;
  /** Git status for this entry. Only present when the entry itself has a
   *  non-clean state in `git status --porcelain`. */
  status?: ProjectTreeStatus;
  /** True for directories that contain at least one descendant with a
   *  non-clean git status. Lets the UI surface a dot on collapsed folders. */
  hasChanges?: boolean;
}

export interface ProjectTreeResult {
  /** Subpath that was actually listed (forward slashes, no leading slash).
   *  Empty string for the project root. */
  subPath: string;
  children: ProjectTreeNode[];
  /** True when the project isn't a git repo — the UI suppresses color
   *  overlays in that case but still renders the listing. */
  gitless?: boolean;
}
