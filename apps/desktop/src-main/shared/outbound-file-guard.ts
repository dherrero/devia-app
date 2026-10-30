import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  MAX_UPLOAD_BYTES,
  isInsideAnyRoot,
  isRootTooBroad,
  isSecretPath,
  mimeFromName,
  outboundKind,
  type OutboundKind,
} from '../../shared/domain/outbound-file-policy';

/**
 * The ONE guard deciding whether a file may leave the machine through
 * `devia_send_file` (S-32). Shared by the out-of-process `devia-ui` MCP server
 * (which validates before the rendezvous, so the agent learns about a refusal
 * in its own tool result) and the main process (which revalidates before the
 * upload: the request file sits in a tmp dir and is not trusted).
 *
 * Node-only, NO Electron: the MCP server runs as plain Node. The pure rules
 * (denylist, root containment, mime) live in `outbound-file-policy.ts`; this
 * file only adds what needs the filesystem.
 */

export type OutboundRefusalReason =
  | 'not_found'
  | 'not_a_file'
  | 'outside_roots'
  | 'secret'
  | 'too_large'
  | 'hardlink'
  | 'devia_data'
  | 'home_root'
  | 'invalid';

/**
 * The stat identity of the file the guard validated. The uploader opens the
 * file again (O_NOFOLLOW), `fstat`s the descriptor and refuses to send it when
 * `dev`/`ino` (or the size) differ — the path may have been swapped since.
 */
export interface OutboundFileIdentity {
  dev: number;
  ino: number;
}

export interface OutboundFileOk {
  ok: true;
  /** Real path (symlinks resolved) — the one to upload. */
  absPath: string;
  name: string;
  size: number;
  mime: string;
  kind: OutboundKind;
  /** `lstat` identity of `absPath` at validation time. */
  dev: number;
  ino: number;
}

export interface OutboundFileRefused {
  ok: false;
  reason: OutboundRefusalReason;
  /** English, actionable, addressed to the agent. Never contains file content. */
  message: string;
}

export type OutboundFileCheck = OutboundFileOk | OutboundFileRefused;

export interface OutboundFileCheckInput {
  /** As the agent wrote it: relative to `cwd`, or absolute. */
  requestedPath: string;
  /** Absolute working directory of the run. */
  cwd: string;
  /** Absolute folders a file may be sent from (workspace roots). */
  roots: readonly string[];
  /**
   * Absolute folders NOTHING may be sent from, even when a root contains them:
   * Devia's own data dir (transcripts, memory, attachments, outbox archive).
   * A root nested INSIDE one of them (a live session worktree under
   * `<deviaDir>/worktrees/`) is the explicit exception: the most specific
   * folder wins.
   */
  denyRoots?: readonly string[];
  /** Defaults to `os.homedir()`; a root equal to it or above it is unusable. */
  homeDir?: string;
  /** Defaults to Telegram's bot upload cap. */
  maxBytes?: number;
}

export function checkOutboundFile(input: OutboundFileCheckInput): OutboundFileCheck {
  const { requestedPath, cwd, roots } = input;
  const maxBytes = input.maxBytes ?? MAX_UPLOAD_BYTES;
  const requested = requestedPath.trim();

  if (!requested || requested.includes('\0')) {
    return refuse('invalid', 'Invalid path: pass the file path relative to the working directory.');
  }
  if (!path.isAbsolute(requested) && !path.isAbsolute(cwd)) {
    return refuse('invalid', 'Cannot resolve a relative path: the working directory is unknown. Pass an absolute path.');
  }
  const absoluteRoots = roots.filter((r) => path.isAbsolute(r));
  if (absoluteRoots.length === 0) {
    return refuse('outside_roots', 'No folders are allowed for sending files in this run.');
  }
  // A root that is the home folder (or above it) puts every dotfile in reach
  // of one misjudged pattern: it is dropped, never trusted.
  const homes = homeForms(input.homeDir ?? os.homedir());
  const usableRoots = absoluteRoots.filter((r) => !tooBroad(r, homes));
  if (usableRoots.length === 0) {
    return refuse(
      'home_root',
      'Refused: the workspace root is your home folder (or a folder above it), so file sending is disabled. ' +
        'Tell the user to pick a narrower workspace root in Devia to send files.',
    );
  }

  const resolved = path.resolve(cwd, requested);
  const realRoots = usableRoots.map(realpathOrNull).filter((r): r is string => r !== null);
  const allRoots = [...usableRoots, ...realRoots];
  const denyRoots = (input.denyRoots ?? []).filter((r) => path.isAbsolute(r));
  const allDeny = [...denyRoots, ...denyRoots.map(realpathOrNull).filter((r): r is string => r !== null)];

  // Lexical containment first (`..` already collapsed by `resolve`), so a path
  // outside the workspace is refused without revealing whether it exists.
  if (!isInsideAnyRoot(resolved, allRoots)) {
    return outside(requested);
  }
  if (isDenied(resolved, allDeny, allRoots)) return deviaData(requested);
  if (looksSecret(requested, resolved, [...allRoots, cwd])) {
    return secret(requested);
  }

  const real = realpathOrNull(resolved);
  if (real === null) {
    return refuse('not_found', `File not found: ${requested}. Check the path (relative to the working directory).`);
  }
  // Re-check on the REAL path: a symlink inside the workspace may point out of it.
  if (!isInsideAnyRoot(real, realRoots)) return outside(requested);
  if (isDenied(real, allDeny, realRoots)) return deviaData(requested);
  if (looksSecret(real, real, realRoots)) return secret(requested);

  // `lstat` on the real path: a symlink swapped in since `realpath` is not a file.
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(real);
  } catch {
    return refuse('not_found', `File not found: ${requested}. Check the path (relative to the working directory).`);
  }
  if (!stat.isFile()) {
    return refuse(
      'not_a_file',
      `${requested} is not a regular file. To send a folder, archive it first (e.g. zip) and send the archive.`,
    );
  }
  // A hard link is the same inode under another name: the denylist judged the
  // NAME in the workspace, while the content may be `~/.ssh/id_rsa`'s.
  if (stat.nlink > 1) {
    return refuse(
      'hardlink',
      `Refused: ${requested} has multiple hard links, so its origin cannot be verified. Copy it to a new file and send the copy.`,
    );
  }

  const name = path.basename(real);
  if (stat.size > maxBytes) {
    return refuse(
      'too_large',
      `${name} is ${formatBytes(stat.size)}; the limit is ${formatBytes(maxBytes)}. ` +
        `Compress it or split it into parts under ${formatBytes(maxBytes)} and send those instead.`,
    );
  }

  const mime = mimeFromName(name);
  return {
    ok: true,
    absPath: real,
    name,
    size: stat.size,
    mime,
    kind: outboundKind(mime, name),
    dev: stat.dev,
    ino: stat.ino,
  };
}

/** `1.5 MB`, `820 KB`, `12 B` — binary units, one decimal under 10. */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const shown = unit === 0 || value >= 10 || Number.isInteger(value) ? Math.round(value) : value.toFixed(1);
  return `${shown} ${units[unit]}`;
}

/**
 * The denylist is judged on the part of the path INSIDE the workspace: a
 * project that merely lives under `~/work/credentials-api/` must not have
 * every file refused because of its own folder name. A path not inside any
 * base is judged whole (conservative).
 */
function looksSecret(raw: string, absolute: string, bases: readonly string[]): boolean {
  if (isSecretPath(tailInside(absolute, bases))) return true;
  return !path.isAbsolute(raw) && isSecretPath(raw);
}

function tailInside(p: string, bases: readonly string[]): string {
  let best: string | null = null;
  for (const base of bases) {
    if (!base || !isInsideAnyRoot(p, [base])) continue;
    if (best === null || base.length > best.length) best = base;
  }
  return best === null ? p : path.relative(best, p);
}

function homeForms(home: string): string[] {
  if (!home || !path.isAbsolute(home)) return [];
  const real = realpathOrNull(home);
  return real && real !== home ? [home, real] : [home];
}

function tooBroad(root: string, homes: readonly string[]): boolean {
  const real = realpathOrNull(root);
  return homes.some((home) => isRootTooBroad(root, home) || (real !== null && isRootTooBroad(real, home)));
}

/**
 * Inside a deny root, unless a send root nested INSIDE that deny root (a
 * session worktree under `<deviaDir>/worktrees/`) also contains it.
 */
function isDenied(p: string, denyRoots: readonly string[], roots: readonly string[]): boolean {
  return denyRoots.some((deny) => {
    if (!isInsideAnyRoot(p, [deny])) return false;
    const nested = roots.filter((r) => isInsideAnyRoot(r, [deny]) && !isInsideAnyRoot(deny, [r]));
    return !isInsideAnyRoot(p, nested);
  });
}

function realpathOrNull(p: string): string | null {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return null;
  }
}

function outside(requested: string): OutboundFileRefused {
  return refuse(
    'outside_roots',
    `Refused: ${requested} is outside the allowed folders. Only files inside the project workspace can be sent; copy it there first if the user asked for it.`,
  );
}

function deviaData(requested: string): OutboundFileRefused {
  return refuse(
    'devia_data',
    `Refused: ${requested} is inside Devia's private data folder (transcripts, memory, attachments). It will not be sent.`,
  );
}

function secret(requested: string): OutboundFileRefused {
  return refuse(
    'secret',
    `Refused: ${requested} looks like a secret/credential file (.env, keys, tokens, git internals). It will not be sent; do not try to work around this.`,
  );
}

function refuse(reason: OutboundRefusalReason, message: string): OutboundFileRefused {
  return { ok: false, reason, message };
}
