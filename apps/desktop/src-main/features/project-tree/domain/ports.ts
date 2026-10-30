import type { ProjectTreeResult } from '../../../../shared/domain/project-tree';

export interface ListOptions {
  /** Bypass the per-project cached git snapshot. Set to true when reacting
   *  to an event that may have changed file status (process:end, manual
   *  refresh). Default false — callers expanding folders during a single
   *  render frame share one git invocation. */
  force?: boolean;
}

/**
 * Lists the contents of a single directory inside a project, with each entry
 * annotated by its current git status (when the project is a git repo).
 *
 * Always **lazy**: callers ask for one folder at a time as the UI expands
 * branches. Listing recursively from the root would freeze on monorepos.
 */
export interface ProjectTreeReader {
  /**
   * @param projectName  Path relative to the workspace root (e.g. "my-app"
   *                     or "clients/acme/api"). Same convention as the
   *                     `GitInspector` ports.
   * @param subPath      Path inside the project to list. Empty string or
   *                     omitted lists the project root.
   */
  list(projectName: string, subPath?: string, opts?: ListOptions): Promise<ProjectTreeResult>;
}
