import * as path from 'node:path';
import type { ConfigRepository } from './ports';

export interface ResolvedPath {
  abs: string;
  root: string;
}

export class WorkspaceNotConfiguredError extends Error {
  constructor() {
    super('Workspace no configurado');
    this.name = 'WorkspaceNotConfiguredError';
  }
}

export class PathOutsideWorkspaceError extends Error {
  constructor() {
    super('Path fuera del workspace');
    this.name = 'PathOutsideWorkspaceError';
  }
}

export class InvalidLeafNameError extends Error {
  constructor(message = 'Nombre inválido') {
    super(message);
    this.name = 'InvalidLeafNameError';
  }
}

/**
 * Validates a single path segment (folder/project leaf name). Rejects empty,
 * path separators, dotfiles and traversal tokens so a malicious renderer
 * can't escape the workspaceRoot via a crafted name.
 */
export function validateLeafName(raw: string | undefined): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) throw new InvalidLeafNameError('Nombre vacío');
  if (trimmed === '.' || trimmed === '..') throw new InvalidLeafNameError();
  if (trimmed.includes('/') || trimmed.includes('\\')) throw new InvalidLeafNameError();
  if (trimmed.startsWith('.')) throw new InvalidLeafNameError();
  return trimmed;
}

/**
 * Normalizes a path for comparison purposes.
 *
 * On Windows the filesystem is case-insensitive, so `C:\Projects` and
 * `c:\projects` refer to the same directory. `startsWith` is case-sensitive,
 * so we lowercase both sides before comparing when running on Windows.
 *
 * On POSIX systems the filesystem is case-sensitive and no normalization is
 * applied.
 */
function normalizeForComparison(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

/**
 * Pure containment check: returns `true` when `child` is the same directory
 * as `parent` or is nested inside it.
 *
 * Both arguments must already be resolved absolute paths (i.e. the caller
 * must have run `path.resolve` on them before passing them in).
 *
 * Exported so that `resolveAndValidateCwd` in `cli-adapters` can reuse the
 * exact same algorithm without duplicating it (REV-TS-CLI-12-02) and so that
 * both callers benefit from the Windows case-insensitivity fix
 * (REV-TS-CLI-12-03).
 */
export function isPathContained(child: string, parent: string): boolean {
  const normChild = normalizeForComparison(child);
  const normParent = normalizeForComparison(parent);
  return (
    normChild === normParent || normChild.startsWith(normParent + path.sep)
  );
}

/**
 * Resolves `relPath` under workspaceRoot and refuses anything that escapes
 * it. The shared helper exists because half a dozen features need exactly
 * this guard before touching the filesystem on a renderer-supplied path.
 */
export function resolveInsideWorkspace(
  config: ConfigRepository,
  relPath: string,
): ResolvedPath {
  const { workspaceRoot } = config.get();
  if (!workspaceRoot) throw new WorkspaceNotConfiguredError();
  const root = path.resolve(workspaceRoot);
  const abs = path.resolve(workspaceRoot, relPath || '');
  if (!isPathContained(abs, root)) {
    throw new PathOutsideWorkspaceError();
  }
  return { abs, root };
}
