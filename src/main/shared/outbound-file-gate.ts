import type { RunId } from '../../shared/domain/agent';
import type { RunMode } from '../../shared/domain/run-capabilities';
import { UI_LIMITS, type SendFileAs } from '../../shared/domain/ui-tools';
import * as fs from 'node:fs';

import { MAX_PHOTO_BYTES, type OutboundKind } from '../../shared/domain/outbound-file-policy';
import { checkOutboundFile, type OutboundRefusalReason } from './outbound-file-guard';
import type { RunFile, RunFileSource } from './run-gateway';

/**
 * The main process's half of `devia_send_file` (S-32): what decides, per run,
 * whether a file the agent asked for may actually leave through the relay.
 *
 * The MCP server already validated the request, but its request file sits in
 * a tmp dir the agent can write to directly, and the file may have changed
 * since. So the main process never trusts `absPath`/`size`/`mime` from the
 * request: it re-runs the same guard and builds the `RunFile` from ITS result.
 */

/** Audit tool name for every send-file entry (request, rejection, outcome). */
export const SEND_FILE_AUDIT_TOOL = 'devia_send_file';

export type RunFileRefusalReason = OutboundRefusalReason | 'not_offered' | 'limit';

export type RunFileAdmission =
  | { ok: true; file: RunFile }
  | { ok: false; reason: RunFileRefusalReason; message: string };

/** The fields of a send request that matter here; everything else is recomputed. */
export interface OutboundFileRequest {
  path: string;
  absPath?: string;
  as?: SendFileAs;
  caption?: string;
}

export interface RevalidateOutboundFileInput {
  request: OutboundFileRequest;
  cwd: string;
  roots: readonly string[];
  source: RunFileSource;
  /** Folders nothing may be sent from (Devia's data dir) — see the guard. */
  denyRoots?: readonly string[];
  /** Override for tests; the guard defaults to `os.homedir()`. */
  homeDir?: string;
}

/**
 * Stateless revalidation: the single helper every outbound path must use
 * (the `devia_send_file` tool here, the outbox publish in T-367).
 */
export function revalidateOutboundFile(input: RevalidateOutboundFileInput): RunFileAdmission {
  const { request, cwd, roots, source } = input;
  const check = checkOutboundFile({
    requestedPath: request.absPath ?? request.path,
    cwd,
    roots,
    ...(input.denyRoots !== undefined && { denyRoots: input.denyRoots }),
    ...(input.homeDir !== undefined && { homeDir: input.homeDir }),
  });
  if (!check.ok) return check;
  return {
    ok: true,
    file: {
      path: check.absPath,
      name: check.name,
      size: check.size,
      mime: check.mime,
      kind: resolveKind(check.kind, check.size, request.as ?? 'auto'),
      ...(request.caption !== undefined && { caption: request.caption }),
      source,
      identity: { dev: check.dev, ino: check.ino },
    },
  };
}

/**
 * An outbox file is validated at its ORIGINAL path and then moved into
 * Devia's archive; the published `RunFile` points at the archived copy. A
 * rename keeps the inode, so the admitted identity still holds. The outbox
 * falls back to copy + unlink across filesystems, which mints a NEW inode:
 * then the archived copy (written by Devia from the file just validated) is
 * re-bound to its own identity, as long as it is still a single-link regular
 * file of the validated size. `null` = the archive does not match: do not send.
 */
export function rebindArchivedRunFile(file: RunFile, archivedPath: string): RunFile | null {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(archivedPath);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.nlink > 1 || stat.size !== file.size) return null;
  const same = file.identity?.dev === stat.dev && file.identity?.ino === stat.ino;
  return {
    ...file,
    path: archivedPath,
    identity: same && file.identity ? file.identity : { dev: stat.dev, ino: stat.ino },
  };
}

/**
 * `as: 'document'` always wins; `as: 'photo'` cannot turn a non-photo into one
 * (Telegram's `sendPhoto` would reject it), and a photo over Telegram's photo
 * cap still arrives as a document.
 */
function resolveKind(guessed: OutboundKind, size: number, as: SendFileAs): OutboundKind {
  if (as === 'document') return 'document';
  if (guessed === 'photo' && size > MAX_PHOTO_BYTES) return 'document';
  return guessed;
}

/** Structural subset of `AgentAuditLog` (kept local: shared/ owns no feature types). */
export interface SendFileAuditSink {
  append(entry: {
    ts: number;
    agentId: string;
    project: string;
    tool: string;
    summary?: string;
    runId?: RunId;
    mode?: RunMode;
  }): void;
}

export interface SendFileAuditContext {
  agentId: string;
  project: string;
  runId?: RunId;
  mode?: RunMode;
}

/**
 * One audit entry for a send-file event. Name + size only — NEVER the content
 * or the absolute path. `phase` is e.g. `accepted`, `rejected:<reason>`, and
 * (T-366) `delivered` / `failed:<reason>`.
 */
export function auditSendFile(
  log: SendFileAuditSink | undefined,
  ctx: SendFileAuditContext,
  phase: string,
  file?: Pick<RunFile, 'name' | 'size'>,
): void {
  log?.append({
    ts: Date.now(),
    agentId: ctx.agentId,
    project: ctx.project,
    tool: SEND_FILE_AUDIT_TOOL,
    ...(ctx.runId !== undefined && { runId: ctx.runId }),
    ...(ctx.mode !== undefined && { mode: ctx.mode }),
    summary: file ? `${phase} ${file.name} (${file.size} B)` : phase,
  });
}

export interface RunFileGateOptions {
  /** Relay connected && (remote run || desktop mirror) && `allowFileSend`. */
  canSendFiles: boolean;
  /** `[workspaceRoot]` (+ this run's cwd when it is a live session worktree). */
  sendRoots: readonly string[];
  /** The run's effective cwd: relative paths resolve against it. */
  cwd: string;
  /**
   * Folders nothing may be sent from even when a send root contains them:
   * Devia's data dir (transcripts, memory, attachments, outbox archive). A
   * send root nested inside (a session worktree) stays usable.
   */
  denyRoots?: readonly string[];
  /** Override for tests; the guard defaults to `os.homedir()`. */
  homeDir?: string;
  maxFiles?: number;
  audit?: { log?: SendFileAuditSink; ctx: SendFileAuditContext };
}

/**
 * Per-run policy + counter. Created once per run by `RunInstructionUseCase`,
 * next to the advertised tool set, and consulted on the handler path (the
 * poller sweeps fire-and-forget requests right after, so nothing later sees
 * them).
 */
export class RunFileGate {
  readonly canSendFiles: boolean;
  readonly sendRoots: readonly string[];
  readonly cwd: string;
  private readonly maxFiles: number;
  private admitted = 0;

  constructor(private readonly options: RunFileGateOptions) {
    this.canSendFiles = options.canSendFiles;
    this.sendRoots = [...options.sendRoots];
    this.cwd = options.cwd;
    this.maxFiles = options.maxFiles ?? UI_LIMITS.sendFilesPerRun;
  }

  /** Files admitted so far in this run. */
  get count(): number {
    return this.admitted;
  }

  admit(request: OutboundFileRequest, source: RunFileSource): RunFileAdmission {
    const result = this.check(request, source);
    if (result.ok) {
      this.admitted++;
      this.audit('accepted', result.file);
    } else {
      this.audit(`rejected:${result.reason}`);
    }
    return result;
  }

  private check(request: OutboundFileRequest, source: RunFileSource): RunFileAdmission {
    if (!this.canSendFiles) {
      return { ok: false, reason: 'not_offered', message: 'Sending files is not available in this run.' };
    }
    if (this.admitted >= this.maxFiles) {
      return {
        ok: false,
        reason: 'limit',
        message: `Limit reached: at most ${this.maxFiles} files can be sent per run.`,
      };
    }
    return revalidateOutboundFile({
      request,
      cwd: this.cwd,
      roots: this.sendRoots,
      source,
      ...(this.options.denyRoots !== undefined && { denyRoots: this.options.denyRoots }),
      ...(this.options.homeDir !== undefined && { homeDir: this.options.homeDir }),
    });
  }

  private audit(phase: string, file?: RunFile): void {
    if (!this.options.audit) return;
    auditSendFile(this.options.audit.log, this.options.audit.ctx, phase, file);
  }
}
