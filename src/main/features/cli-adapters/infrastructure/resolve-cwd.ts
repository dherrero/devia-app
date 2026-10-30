import * as path from 'node:path';
import { isPathContained } from '../../../shared/workspace-paths';

/**
 * Checks whether every path in `imagePaths` resolves inside `cwd`.
 *
 * Returns the first offending path string when any image path escapes
 * the workspace, or `null` when all paths are safe.
 *
 * Design decisions:
 * - Relative paths are resolved against `cwd` using `path.resolve`.
 * - An absolute path that does NOT start with `cwd + path.sep` is rejected.
 * - A path that resolves to exactly `cwd` itself is rejected — images
 *   must be files inside the directory, not the directory root.
 * - Pure lexical check (no fs I/O) — existence is verified later by the CLI.
 *
 * @param imagePaths - Array of image paths from the IPC request.
 * @param cwd - The resolved, absolute project CWD returned by `resolveAndValidateCwd`.
 */
export function findEscapingImagePath(
  imagePaths: string[],
  cwd: string,
): string | null {
  const normalizedCwd = path.resolve(cwd);
  for (const p of imagePaths) {
    const abs = path.resolve(cwd, p);
    // Use isPathContained but require the image to be INSIDE cwd, not equal.
    const isInside = abs !== normalizedCwd && isPathContained(abs, normalizedCwd);
    if (!isInside) {
      return p;
    }
  }
  return null;
}

/**
 * Discriminated-union result for CWD validation.
 * The caller must check `.ok` before using `.resolvedPath`.
 */
export type CwdValidationResult =
  | { ok: true; resolvedPath: string }
  | { ok: false; error: string };

/**
 * Resolve `projectName` relative to `workspaceRoot` and assert that the
 * resulting absolute path remains inside the workspace root.
 *
 * This is a path-traversal guard: a malicious or erroneous `projectName`
 * such as `'../../etc/passwd'` or an absolute path like `'/tmp/evil'`
 * will produce an error result instead of a valid CWD.
 *
 * Design decisions:
 * - Uses `path.resolve` (not `path.join`) so that `..` segments and
 *   absolute projectNames are normalized before the containment check.
 * - Symlinks are NOT followed — the check is purely lexical. This is
 *   acceptable for the threat model: symlink attacks require filesystem
 *   access that is already beyond this guard's scope.
 * - Never throws. All errors are returned as `{ ok: false, error }`.
 * - Uses `isPathContained` from `shared/workspace-paths` so the
 *   containment algorithm is defined in a single place (REV-TS-CLI-12-02)
 *   and correctly handles Windows case-insensitivity (REV-TS-CLI-12-03).
 *
 * @param projectName - Relative project directory name (e.g. `'my-project'`).
 *   May contain `..` segments or be absolute — both are caught.
 * @param workspaceRoot - The configured workspace root (e.g. `'/home/user/projects'`).
 *   Must not be empty; empty string returns an error.
 */
export function resolveAndValidateCwd(
  projectName: string,
  workspaceRoot: string,
): CwdValidationResult {
  try {
    if (!workspaceRoot) {
      return { ok: false, error: 'Workspace root is not configured' };
    }

    const normalizedRoot = path.resolve(workspaceRoot);
    const resolved = path.resolve(workspaceRoot, projectName);

    // Accept exact match (project IS the workspace root) OR a strict child.
    // isPathContained handles Windows case-insensitivity and the path.sep
    // suffix guard to prevent /home/user/proj from matching /home/user/projects-evil.
    if (!isPathContained(resolved, normalizedRoot)) {
      return { ok: false, error: 'Project path is outside workspace' };
    }

    return { ok: true, resolvedPath: resolved };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `CWD validation failed: ${message}` };
  }
}
