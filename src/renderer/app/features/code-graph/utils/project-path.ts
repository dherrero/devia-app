const ABSOLUTE = /^(?:[a-zA-Z]:[\\/]|[\\/])/;

/**
 * Absolute path of a root-relative graph path. `project` is the workspace
 * key the graph is keyed by (already absolute for projects outside the
 * workspace). Separators stay `/`: Node and the IDE launchers accept them on
 * Windows too.
 */
export function graphAbsolutePath(workspaceRoot: string | null | undefined, project: string, relative: string): string {
  const root = (workspaceRoot ?? '').replace(/[\\/]+$/, '');
  const base = ABSOLUTE.test(project) || root === '' ? project : `${root}/${project}`;
  const rel = relative.replace(/^[\\/]+/, '');
  return rel === '' ? base : `${base.replace(/[\\/]+$/, '')}/${rel}`;
}
