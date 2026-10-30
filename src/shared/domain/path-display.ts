/**
 * UC-FIX-020: workspace-relative path display helper.
 *
 * Strips the workspace root prefix from an absolute path so the diff viewer
 * shows `src/app/button.ts` rather than `G:\saaaaaaas\project\src\app\button.ts`.
 * Always returns forward-slash paths for consistency across platforms.
 */

export function toRelativePath(absPath: string, workspaceRoot: string): string {
  if (!workspaceRoot) return normaliseSlashes(absPath);

  // Remove trailing separator from root before comparing.
  const root = workspaceRoot.replace(/[/\\]+$/, '');

  // Use case-insensitive comparison: on Windows paths are case-insensitive,
  // and the slight over-match on case-sensitive POSIX is acceptable for display.
  const pathLower = absPath.toLowerCase();
  const rootLower = root.toLowerCase();

  if (pathLower.startsWith(rootLower)) {
    const rest = absPath.slice(root.length).replace(/^[/\\]/, '');
    return normaliseSlashes(rest) || normaliseSlashes(absPath);
  }

  return normaliseSlashes(absPath);
}

function normaliseSlashes(p: string): string {
  return p.replace(/\\/g, '/');
}
