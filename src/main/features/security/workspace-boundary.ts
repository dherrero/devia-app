import * as fs from 'node:fs';
import * as path from 'node:path';
import { isPathContained } from '../../shared/workspace-paths';

export type WorkspaceBoundaryError = 'escape' | 'symlink_escape' | 'not_found';

export type WorkspaceBoundaryResult =
  | { ok: true; path: string }
  | { ok: false; reason: WorkspaceBoundaryError };

/**
 * Guards all path I/O against workspace escapes.
 *
 * `resolve()` normalizes and resolves symlinks; it returns an error result
 * instead of throwing so callers can surface a typed `PATH_ESCAPE` error
 * rather than catching an exception (AC1, AC2).
 */
export interface WorkspaceBoundary {
  readonly root: string;
  resolve(input: string): WorkspaceBoundaryResult;
}

export class SimpleWorkspaceBoundary implements WorkspaceBoundary {
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  resolve(input: string): WorkspaceBoundaryResult {
    // Step 1: normalize without resolving symlinks.
    const normalized = path.resolve(this.root, input);
    if (!isPathContained(normalized, this.root)) {
      return { ok: false, reason: 'escape' };
    }

    // Step 2: check whether the path exists.
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(normalized);
    } catch {
      return { ok: false, reason: 'not_found' };
    }

    // Step 3: if it's a symlink, verify the real target stays inside.
    if (stat.isSymbolicLink()) {
      let realPath: string;
      try {
        realPath = fs.realpathSync(normalized);
      } catch {
        return { ok: false, reason: 'not_found' };
      }
      if (!isPathContained(realPath, this.root)) {
        return { ok: false, reason: 'symlink_escape' };
      }
      return { ok: true, path: realPath };
    }

    return { ok: true, path: normalized };
  }
}

/**
 * Creates a `WorkspaceBoundary` for the given root path.
 */
export function createWorkspaceBoundary(root: string): WorkspaceBoundary {
  return new SimpleWorkspaceBoundary(root);
}
