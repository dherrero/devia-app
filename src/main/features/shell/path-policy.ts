import * as fs from 'node:fs';
import * as path from 'node:path';
import { isInsideAnyRoot, mimeFromName } from '../../../shared/domain/outbound-file-policy';

/**
 * Guard for `shell:openPath` / `shell:reveal`. The renderer hands those
 * channels a path the agent may have chosen (outbox card, tool-call chips), and
 * `shell.openPath` EXECUTES whatever the OS associates with it (`.command`,
 * `.app`, `.bat`…). So a path is only honoured inside the known roots, and only
 * media is ever opened; everything else is revealed in the file manager.
 */

export type ShellPathDecision =
  | { action: 'open'; path: string }
  | { action: 'reveal'; path: string }
  | { action: 'deny' };

/** Directories the OS launches instead of browsing. */
const LAUNCHABLE_DIR = /\.(app|workflow|action|bundle|command)$/i;

function realpathOrNull(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

function isMedia(name: string): boolean {
  return /^(image|video|audio)\//.test(mimeFromName(name));
}

/**
 * `roots` are absolute folders (workspaceRoot, outbox-archive, attachments…).
 * Symlinks are resolved on both sides so a link inside a root cannot point out
 * of it; a path that does not exist is denied.
 */
export function decideShellPath(raw: unknown, roots: readonly string[]): ShellPathDecision {
  if (typeof raw !== 'string' || !raw || raw.includes('\0') || !path.isAbsolute(raw)) {
    return { action: 'deny' };
  }
  const real = realpathOrNull(raw);
  if (real === null) return { action: 'deny' };
  const realRoots = roots
    .filter((r) => path.isAbsolute(r))
    .map(realpathOrNull)
    .filter((r): r is string => r !== null);
  if (!isInsideAnyRoot(real, realRoots)) return { action: 'deny' };

  let isDir: boolean;
  try {
    isDir = fs.statSync(real).isDirectory();
  } catch {
    return { action: 'deny' };
  }
  const name = path.basename(real);
  if (isDir) {
    return LAUNCHABLE_DIR.test(name) ? { action: 'reveal', path: real } : { action: 'open', path: real };
  }
  return isMedia(name) ? { action: 'open', path: real } : { action: 'reveal', path: real };
}
