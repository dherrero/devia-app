import type { UserFacingError } from '../../shared/domain/user-facing-error';
import type { RunId } from '../../shared/domain/agent';
import type { CancelReason } from '../../shared/domain/agent-event';
import type { SendInstructionResult } from '../../shared/domain/queue';
import type { RunMode } from '../../shared/domain/run-capabilities';
import type { AssignQuestion, WorkerRun } from '../../shared/domain/cross-agent';

/**
 * In-process bridge between the claude-runner and other main-process consumers
 * that need to drive runs and observe their output without importing the
 * runner's internals (E-DSK-14).
 *
 * The renderer talks to the runner through IPC; the Telegram controller can't.
 * Instead the runner binds its queue-aware "submit instruction" entry point and
 * republishes every run lifecycle event here, so the remote-control feature can
 * launch instructions exactly like the UI does (same queue + same renderer
 * mirror) and stream the agent's reply back to the chat.
 */
export type RunOrigin = 'renderer' | 'remote';

export interface RunSubmitOptions {
  /** Where the instruction came from. `remote` makes the runner emit a
   *  `queue:dispatched` so the renderer shows the user bubble it didn't type. */
  origin?: RunOrigin;
  mode?: RunMode;
  /** S-56: run under this identity instead of the project's own, so a worker's
   *  events, queue and registry entry never mix with the controller's. */
  runKey?: string;
  /** S-56: session id the run is seeded with (it fixes the worktree path). */
  sessionId?: string;
  /** S-56: run inside the session's own worktree. */
  isolate?: boolean;
  /** S-56: run with this agent instead of the effective one. */
  agentIdOverride?: string;
}

export type RunSubmitFn = (
  project: string,
  text: string,
  opts?: RunSubmitOptions,
) => SendInstructionResult;

export interface RunStartEvent {
  type: 'start';
  project: string;
  runId?: RunId;
  agentId?: string;
  /** The instruction text that started the run. Carried so a remote observer
   *  (the Telegram desktop→chat mirror) can show the user prompt. */
  text?: string;
}
export interface RunOutputEvent {
  type: 'output';
  project: string;
  runId?: RunId;
  /** A Claude-stream-json line (translated for non-Claude adapters). */
  line: string;
}
export interface RunEndEvent {
  type: 'end';
  project: string;
  runId?: RunId;
  code: number | null;
  error?: string;
  /**
   * Structured cause of a cancellation, when the run was cancelled: `user`
   * (Stop / `/stop`), `idle`, `question_timeout`. Lets a relay tell a real
   * user stop apart from a failure without parsing `error`.
   */
  cancelReason?: CancelReason;
  /** S-54: what happened, why and what to do; `error` stays the raw agent text. */
  userError?: UserFacingError;
}
/** Where an outbound file came from: the `devia_send_file` tool or the outbox. */
export type RunFileSource = 'tool' | 'outbox';

/**
 * The stat identity (`dev` + `ino`) of the file the guard validated. The
 * uploader opens `path` with `O_NOFOLLOW`, `fstat`s the descriptor and refuses
 * to send when `dev`/`ino`/`size` differ or `nlink > 1`: the path may have
 * been swapped (symlink, rename, hard link) between admission and upload.
 */
export interface RunFileIdentity {
  dev: number;
  ino: number;
}

/**
 * A file the main process already REVALIDATED for this run (S-32) — see
 * `RunFileGate` / `revalidateOutboundFile`. `path` is the real path to upload.
 */
export interface RunFile {
  path: string;
  name: string;
  /** Size the guard validated (the uploader re-checks it against `fstat`). */
  size: number;
  mime: string;
  kind: 'photo' | 'video' | 'audio' | 'document';
  caption?: string;
  source: RunFileSource;
  /**
   * Identity captured at admission. For `outbox` files it was taken on the
   * ORIGINAL path inside `outbox/`; the archive move is a rename, which keeps
   * the inode, so it still describes the archived `path` (a cross-device copy
   * is re-bound by `rebindArchivedRunFile`). Optional for older producers;
   * the gate always sets it.
   */
  identity?: RunFileIdentity;
}

/** A run asked to deliver a file to the remote chat (S-32). */
export interface RunFileEvent {
  type: 'file';
  project: string;
  runId?: RunId;
  file: RunFile;
}
/**
 * An outbox file the run produced but that may NOT leave through the relay
 * (secret, over the size cap, per-run limit…). The file itself stays archived
 * locally; the chat only learns its name so it can say "couldn't send X".
 */
export interface RunFileRejectedEvent {
  type: 'file_rejected';
  project: string;
  runId?: RunId;
  name: string;
  reason: string;
  source: RunFileSource;
}
/**
 * S-56 T12: the agent of a REMOTE run asked the user which agent runs each
 * role. The relay shows the question as text; the user's reply goes back
 * through {@link RunGateway.answerTool}.
 */
export interface RunAskEvent {
  type: 'ask';
  project: string;
  runId?: RunId;
  callId: string;
  question: AssignQuestion;
  mainAgentId: string;
}

/** S-56 T12: a cross-agent worker of `project`'s controller changed state. */
export interface RunWorkerEvent {
  type: 'worker';
  project: string;
  worker: WorkerRun;
}

export type RunGatewayEvent =
  | RunStartEvent
  | RunOutputEvent
  | RunEndEvent
  | RunFileEvent
  | RunFileRejectedEvent
  | RunAskEvent
  | RunWorkerEvent;

export type RunGatewayListener = (event: RunGatewayEvent) => void;

export class RunGateway {
  private submitFn: RunSubmitFn | null = null;
  private stopFn: ((project: string) => boolean) | null = null;
  private resetFn: ((project: string) => boolean) | null = null;
  private toolResultFn: ((project: string, callId: string, answer: string) => void) | null = null;
  private readonly listeners = new Set<RunGatewayListener>();

  /** Called once by the runner's IPC adapter at registration time. */
  bindSubmit(fn: RunSubmitFn): void {
    this.submitFn = fn;
  }
  bindStop(fn: (project: string) => boolean): void {
    this.stopFn = fn;
  }
  bindResetSession(fn: (project: string) => boolean): void {
    this.resetFn = fn;
  }
  bindToolResult(fn: (project: string, callId: string, answer: string) => void): void {
    this.toolResultFn = fn;
  }

  /** Submit an instruction through the runner's queue-aware path. */
  submit(project: string, text: string, opts?: RunSubmitOptions): SendInstructionResult {
    if (!this.submitFn) throw new Error('RunGateway: submit not bound yet');
    return this.submitFn(project, text, opts);
  }

  /** Cancel the active run for a project. Returns false if not bound. */
  stop(project: string): boolean {
    return this.stopFn ? this.stopFn(project) : false;
  }

  /** Reset the agent session for a project (next run starts fresh). */
  resetSession(project: string): boolean {
    return this.resetFn ? this.resetFn(project) : false;
  }

  /** Answer a blocked `devia-ui` tool call (e.g. the assignment question). False when not bound. */
  answerTool(project: string, callId: string, answer: string): boolean {
    if (!this.toolResultFn) return false;
    this.toolResultFn(project, callId, answer);
    return true;
  }

  /** Subscribe to run lifecycle events. Returns an unsubscribe function. */
  subscribe(listener: RunGatewayListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Republish a run event. A throwing listener never breaks the run. */
  publish(event: RunGatewayEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        /* a remote observer must never break the run pipeline */
      }
    }
  }
}
