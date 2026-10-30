import { Notification, powerMonitor } from 'electron';
import type { FeatureContext } from '../../../shared/feature';
import { AutoResumeScheduler } from '../application/auto-resume-scheduler';
import { IPC } from '../../../../shared/contracts/ipc-channels';
import type { RunInstructionUseCase, RunInstructionHandlers } from '../application/run-instruction.use-case';
import type { RunFile, RunGateway } from '../../../shared/run-gateway';
import type { StopProjectUseCase } from '../application/stop-project.use-case';
import type { StopAllUseCase } from '../application/stop-all.use-case';
import type { ResetSessionUseCase } from '../application/reset-session.use-case';
import type { AttachmentEnricher, ConfigRepository, GitInspector } from '../../../shared/ports';
import type { AttachmentPayload } from '../../../../shared/domain/attachment';
import type { QueueItem, SendInstructionResult } from '../../../../shared/domain/queue';
import type { QueueService } from '../../queue';
import type { ProcessTrackingRegistry } from '../domain/ports';
import type { AgentAuditLog } from '../../security/audit-log';
import type { RunId } from '../../../../shared/domain/agent';
import type { RunMode } from '../../../../shared/domain/run-capabilities';

export interface ClaudeRunnerIpcDeps {
  runInstruction: RunInstructionUseCase;
  stopProject: StopProjectUseCase;
  stopAll: StopAllUseCase;
  resetSession: ResetSessionUseCase;
  attachments: AttachmentEnricher;
  queue: QueueService;
  registry: ProcessTrackingRegistry;
  /** Read for `autoContinueSessions` and the active agent when a resume is due. */
  config: ConfigRepository;
  /** FR-4: audit log instance used by the `audit:read` IPC handler. */
  auditLog: AgentAuditLog;
  /**
   * Git inspector used to fetch diff snapshots after file-editing tool results
   * (TS-CLI-10). Optional — when absent the diff feature is disabled silently.
   */
  gitInspector?: GitInspector;
  /**
   * Run gateway (E-DSK-14). When present, the queue-aware submit path is bound
   * to it and every run lifecycle event is republished, so the Telegram
   * controller can drive and observe runs without importing the runner.
   */
  runGateway?: RunGateway;
  /**
   * S-25 F2.6: pushes a `devia_notify` message to the chat relay. Optional —
   * without it the notification is desktop-only, which is the right degradation
   * rather than a failure.
   */
  notifyRemote?: (text: string) => void;
}

/** What the continue run needs to be the same kind of run as the one the limit cut short. */
interface ResumeContext {
  base: string;
  mode: RunMode;
  origin: 'renderer' | 'remote';
  isolate: boolean;
  runKey?: string;
  sessionId?: string;
}

const CONTINUE_PROMPT = 'Continue where you left off.';

export function registerClaudeRunnerIpc(ctx: FeatureContext, deps: ClaudeRunnerIpcDeps): { dispose(): void } {
  // Automatic resume after the account's usage limit (see AutoResumeScheduler).
  const resumeContexts = new Map<string, ResumeContext & { agentId: string }>();
  // True only while the scheduler itself submits the continue, so that run is
  // not mistaken for the user typing (which cancels a pending resume).
  let resuming = false;
  const autoResume = new AutoResumeScheduler({
    now: Date.now,
    onScheduled: (key, fireAt) => ctx.send('autoresume:scheduled', { project: key, fireAt }),
    onCancelled: (key, reason) => {
      resumeContexts.delete(key);
      ctx.send('autoresume:cancelled', { project: key, reason });
    },
    onDue: (key) => {
      const rc = resumeContexts.get(key);
      resumeContexts.delete(key);
      ctx.send('autoresume:cancelled', { project: key, reason: 'fired' });
      const cfg = deps.config.get();
      // Switching the agent or turning the switch off while waiting must not
      // resume: a different agent would start the session without its context.
      if (!rc || cfg.agentId !== rc.agentId || cfg.autoContinueSessions?.[rc.agentId] !== true) {
        deps.queue.dispatchNext(key);
        return;
      }
      resuming = true;
      try {
        submitInstruction(rc.base, CONTINUE_PROMPT, [], rc.mode, rc.origin, undefined, {
          isolate: rc.isolate,
          ...(rc.runKey !== undefined && { runKey: rc.runKey }),
          ...(rc.sessionId !== undefined && { sessionId: rc.sessionId }),
        });
      } finally {
        resuming = false;
      }
    },
  });
  const onPowerResume = (): void => autoResume.tick();
  powerMonitor.on('resume', onPowerResume);

  /** Cancels a pending resume and lets whatever was parked behind it run. */
  const cancelAutoResume = (key: string, reason: 'user' | 'stopped' | 'reset'): void => {
    if (!autoResume.isPending(key)) return;
    autoResume.cancel(key, reason);
    if (reason === 'user') deps.queue.dispatchNext(key);
  };

  /**
   * Non-blocking diff snapshot fetch. Called after a file-editing tool_result
   * arrives. Failures are silently swallowed so a missing git install or
   * non-git project never surfaces to the user (TR-2, FR-3 of TS-CLI-10).
   */
  const sendDiffSnapshot = (
    projectName: string,
    toolCallId: string,
    projectCwd: string,
    runId: RunId,
    identity: string = projectName,
  ): void => {
    if (!deps.gitInspector) return;
    // REV-TS-CLI-10-02: use the non-blocking asyncDiff so the V8 event loop
    // is never blocked on large repositories. The promise is intentionally
    // fire-and-forget; errors are swallowed so a missing git install or
    // non-git project never surfaces to the user (TR-2, FR-3 of TS-CLI-10).
    // The diff is computed for projectName (the checkout); the event's `project`
    // carries the session identity so the renderer routes it to the right pane.
    deps.gitInspector.asyncDiff(projectName).then((result) => {
      if (result.hasChanges && result.files.length > 0) {
        ctx.send('git:diff-snapshot', { project: identity, runId, toolCallId, diff: result.files });
      }
    }).catch(() => { /* git not available or not a repo — silently skip */ });
    void projectCwd; // suppress unused-variable warning
  };

  // Fire an OS-level notification when a Claude run finishes while the app
  // isn't focused. The in-app toast still covers the cross-project case;
  // this handles the user being on another window or having the app hidden.
  // Skips `busy`/`stopped` since those are user-initiated outcomes.
  const notifyIfBackground = (project: string, error: string | undefined): void => {
    if (error === 'busy' || error === 'stopped') return;
    if (!Notification.isSupported()) return;
    const win = ctx.getMainWindow();
    if (win && win.isFocused()) return;
    const leaf = project.split('/').pop() ?? project;
    const body = error ? `Error en ${leaf}: ${error}` : `Claude terminó en ${leaf}`;
    const notification = new Notification({ title: 'Devia', body });
    notification.on('click', () => {
      const target = ctx.getMainWindow();
      if (target) {
        if (target.isMinimized()) target.restore();
        target.show();
        target.focus();
      }
      ctx.send('notification:click', { project });
    });
    notification.show();
  };

  /**
   * S-25 F2.6 — `devia_notify`.
   *
   * Rate limited to one notification per run every 30 s. An agent in a loop
   * must not be able to turn into an OS-level spammer; the excess is dropped
   * silently (the tool already acked, so there is nothing to fail) and audited
   * by the runner as any other call.
   *
   * Returns whether the renderer should still see the event.
   */
  const NOTIFY_INTERVAL_MS = 30_000;
  const lastNotifyByRun = new Map<string, number>();

  const deliverNotification = (project: string, runId: string, input: unknown): boolean => {
    const payload = input as { title?: string; body?: string } | null;
    const title = typeof payload?.title === 'string' ? payload.title : '';
    if (!title) return false;

    const now = Date.now();
    const last = lastNotifyByRun.get(runId) ?? 0;
    if (now - last < NOTIFY_INTERVAL_MS) return false;
    lastNotifyByRun.set(runId, now);

    const body = typeof payload?.body === 'string' ? payload.body : '';
    const text = body ? `${title}\n${body}` : title;

    // The chat relay is the only channel a user away from the desk actually
    // has, so it fires regardless of window focus.
    deps.notifyRemote?.(text);

    const win = ctx.getMainWindow();
    if (win?.isFocused()) return true; // the renderer toasts instead
    if (!Notification.isSupported()) return true;

    const notification = new Notification({ title: `Devia · ${title}`, ...(body && { body }) });
    notification.on('click', () => {
      const target = ctx.getMainWindow();
      if (target) {
        if (target.isMinimized()) target.restore();
        target.show();
        target.focus();
      }
      ctx.send('notification:click', { project });
    });
    notification.show();
    return true;
  };

  // Build the run lifecycle handlers shared by the queue dispatcher and the
  // direct/remote submit paths. Each event is sent to the renderer AND
  // republished to the run gateway (E-DSK-14) so the Telegram controller
  // mirrors the run. `extras.onStart` lets a caller emit `queue:dispatched`
  // first (so the renderer appends a user bubble it did not type); `onBusy`
  // lets the queue dispatcher learn the runner refused to spawn.
  const buildRunHandlers = (
    projectName: string,
    extras?: { onStart?: () => void; onBusy?: () => void; resume?: ResumeContext },
    text?: string,
    runKey?: string,
  ): RunInstructionHandlers => {
    let hitLimit = false;
    // Identity = the per-session key the renderer routes state by (T-143). For
    // a single pane it equals projectName, so events are byte-identical to
    // before. `projectName` is still used where the concern is the project
    // itself (background notification navigation, git diff of the checkout).
    const identity = runKey ?? projectName;
    return {
    onProcessStart: ({ runId, agentId }) => {
      extras?.onStart?.();
      ctx.send('process:start', { project: identity, runId, agentId });
      deps.runGateway?.publish({
        type: 'start',
        project: identity,
        ...(runId !== undefined && { runId }),
        ...(agentId !== undefined && { agentId }),
        ...(text !== undefined && { text }),
      });
    },
    onClaudeOutput: (line, runId) => {
      ctx.send('claude:output', { project: identity, runId, line });
      deps.runGateway?.publish({ type: 'output', project: identity, runId, line });
    },
    onRateLimited: ({ agentId, resetsAt }) => {
      hitLimit = true;
      if (!extras?.resume || resetsAt === undefined) return;
      if (deps.config.get().autoContinueSessions?.[agentId] !== true) return;
      resumeContexts.set(identity, { ...extras.resume, agentId });
      if (!autoResume.schedule(identity, resetsAt)) resumeContexts.delete(identity);
    },
    onProcessEnd: ({ runId, code, error, classification, signal, cancelReason, classifiedError }) => {
      if (error === 'busy') extras?.onBusy?.();
      if (!hitLimit && code === 0) autoResume.noteCleanRun(identity);
      ctx.send('process:end', {
        project: identity,
        ...(runId !== undefined && { runId }),
        code,
        ...(error !== undefined && { error }),
        ...(classification !== undefined && { classification }),
        ...(signal !== undefined && { signal }),
        ...(cancelReason !== undefined && { cancelReason }),
        ...(classifiedError !== undefined && {
          failoverReason: classifiedError.reason,
          ...(classifiedError.hint !== undefined && { failoverHint: classifiedError.hint }),
          ...(classifiedError.retryAfterSeconds !== undefined && {
            retryAfterSeconds: classifiedError.retryAfterSeconds,
          }),
        }),
      });
      deps.runGateway?.publish({
        type: 'end',
        project: identity,
        ...(runId !== undefined && { runId }),
        code,
        ...(error !== undefined && { error }),
        ...(cancelReason !== undefined && { cancelReason }),
      });
      notifyIfBackground(projectName, error);
      // Drain this session's own queue (keyed by identity, T-143). For the
      // primary/single pane identity === projectName, unchanged.
      // Parked items would only hit the same limit: they wait for the resume.
      if (error !== 'busy' && !autoResume.isPending(identity)) deps.queue.dispatchNext(identity);
    },
    // Routed by session identity like every other run event, so an isolated
    // pane's outbox card lands in that pane.
    onOutboxFile: (file) => ctx.send('outbox:file', { ...file, project: identity }),
    onRunFile: (file, runId) => {
      deps.runGateway?.publish({ type: 'file', project: identity, runId, file });
    },
    onRunFileRejected: ({ name, reason, source }, runId) => {
      deps.runGateway?.publish({ type: 'file_rejected', project: identity, runId, name, reason, source });
    },
    onQuestionAsk: (toolUseId, question, runId, options, questions) => {
      ctx.send('question:ask', {
        project: identity,
        runId,
        toolUseId,
        question,
        ...(options ? { options } : {}),
        ...(questions ? { questions } : {}),
      });
    },
    onUiToolRequest: (callId, tool, input, runId, expectsAnswer) => {
      // `notify` is the one tool whose real effect is OUTSIDE the window: an OS
      // notification and, when the relay is up, the chat. It still reaches the
      // renderer so a focused window can toast instead of double-notifying.
      if (tool === 'notify' && !deliverNotification(identity, runId, input)) return;
      // S-32: the runner only forwards a `send_file` it already revalidated
      // (`RunFileGate`), so `input` IS the trusted `RunFile`. The relay picks
      // it up from the gateway; the renderer still draws it.
      if (tool === 'send_file') {
        if (!isRunFile(input)) return;
        deps.runGateway?.publish({ type: 'file', project: identity, runId, file: input });
      }
      ctx.send('ui:tool-request', { project: identity, runId, callId, tool, input, expectsAnswer });
    },
    onFileToolResult: (toolUseId, cwd, runId) => {
      sendDiffSnapshot(projectName, toolUseId, cwd, runId, identity);
    },
    };
  };

  // Single source of truth for "run this text right now". Reused by the
  // direct IPC path (user hits Enter) and by the queue dispatcher (head
  // pops after a process ends). Returns whether the runner accepted the
  // call so the queue can leave the item parked on refusal (busy /
  // missing workspace) — see QueueService.dispatchNext.
  const startRun = (dispatchKey: string, text: string, item?: QueueItem): boolean => {
    let accepted = true;
    // The queue is keyed by the session IDENTITY (T-143). For an additional
    // pane the dispatch key is its runKey, so the BASE project for cwd comes
    // from the stored item; for the primary/single pane there is no item
    // context and the dispatch key IS the base project.
    const base = item?.baseProject ?? dispatchKey;
    const runKey = item?.runKey;
    const identity = runKey ?? dispatchKey;
    deps.runInstruction.execute(
      base,
      text,
      [],
      buildRunHandlers(base, {
        // Queue dispatch path: tell the renderer the popped instruction text so
        // it can append the user bubble below the previous response. The queued
        // displayText rides along so system prompts (SDD planner, wake) render
        // as the message the user actually saw, never the raw internal prompt.
        // `project` carries the identity so it lands in the right pane.
        onStart: () => ctx.send('queue:dispatched', {
          projectName: identity,
          text,
          ...(item?.displayText !== undefined && { displayText: item.displayText }),
        }),
        onBusy: () => {
          accepted = false;
        },
        ...(item?.agentIdOverride === undefined && {
          resume: {
            base,
            mode: item?.mode ?? 'apply',
            origin: item?.origin ?? 'renderer',
            isolate: item?.isolate ?? false,
            ...(runKey !== undefined && { runKey }),
            ...(item?.sessionId !== undefined && { sessionId: item.sessionId }),
          },
        }),
      }, text, runKey),
      // Replay the mode captured at enqueue time — a queued PLAN instruction
      // must not silently dispatch under the default 'apply'.
      item?.mode,
      [],
      // Keep a queued remote (Telegram) run remote so it gets the remote
      // protocol + AskUserQuestion auto-answer.
      item?.origin ?? 'renderer',
      item?.isolate ?? false,
      runKey,
      item?.sessionId,
      // S-2 F3.4: a queued handoff-summary request keeps its agent override.
      item?.agentIdOverride,
    );
    return accepted;
  };

  // The queue feature dispatches popped items through this adapter. The
  // queue cannot import the use case directly — that would re-introduce
  // the runner ↔ queue cycle the composition root carefully avoids.
  deps.queue.attachDispatcher({ dispatch: startRun });

  // Queue-aware submit reused by the renderer (origin 'renderer') and the
  // Telegram controller via the run gateway (origin 'remote'). Remote runs
  // emit `queue:dispatched` on start so the renderer shows the user bubble.
  const submitInstruction = (
    projectName: string,
    instruction: string,
    attachments: AttachmentPayload[],
    mode: RunMode,
    origin: 'renderer' | 'remote',
    displayText?: string,
    // T-143: a split pane passes its session identity + isolate flag so the run
    // is keyed per-session and (when isolate) runs in its own worktree. Omitted
    // by every current caller ⇒ identity = projectName, single-pane unchanged.
    runOpts?: { runKey?: string; isolate?: boolean; sessionId?: string; agentIdOverride?: string },
  ): SendInstructionResult => {
    // Bake any attachments into the augmented text *at enqueue time* when the
    // queue path is taken, so the persisted queue file never carries base64
    // buffers. Inline runs let the use case do the saving so attachment errors
    // still surface as process:end+error the way they always have.
    // T-143: the queue is keyed by the session identity so an additional pane
    // parks/runs independently of the primary pane (and they never share a
    // queue). identity === projectName for the primary/single pane (unchanged).
    const identity = runOpts?.runKey ?? projectName;
    if (!resuming) cancelAutoResume(identity, 'user');
    if (deps.queue.shouldEnqueue(identity)) {
      let augmented = instruction;
      if (attachments.length > 0) {
        try {
          const saved = deps.attachments.saveAll(attachments);
          augmented = deps.attachments.augmentInstruction(instruction, saved);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          ctx.send('process:end', { project: identity, code: 1, error: `Error guardando adjuntos: ${message}` });
          return { queued: false };
        }
      }
      const item = deps.queue.add(identity, augmented, {
        ...(displayText !== undefined && { displayText }),
        mode,
        origin,
        // Stored so the dispatcher can recreate the isolated run later.
        ...(runOpts?.runKey !== undefined && { baseProject: projectName, runKey: runOpts.runKey }),
        ...(runOpts?.isolate === true && { isolate: true }),
        ...(runOpts?.sessionId !== undefined && { sessionId: runOpts.sessionId }),
        ...(runOpts?.agentIdOverride !== undefined && { agentIdOverride: runOpts.agentIdOverride }),
      });
      const position = deps.queue.view(identity).items.findIndex((it) => it.id === item.id) + 1;
      return { queued: true, position };
    }

    // Inline path — same shape the runner has always seen. A remote-origin run
    // gets a `queue:dispatched` so the renderer renders the user bubble.
    deps.runInstruction.execute(
      projectName,
      instruction,
      attachments,
      buildRunHandlers(
        projectName,
        {
          ...(origin === 'remote' && {
            onStart: () => ctx.send('queue:dispatched', {
              projectName,
              text: instruction,
              ...(displayText !== undefined && { displayText }),
            }),
          }),
          ...(runOpts?.agentIdOverride === undefined && {
            resume: {
              base: projectName,
              mode,
              origin,
              isolate: runOpts?.isolate ?? false,
              ...(runOpts?.runKey !== undefined && { runKey: runOpts.runKey }),
              ...(runOpts?.sessionId !== undefined && { sessionId: runOpts.sessionId }),
            },
          }),
        },
        instruction,
        runOpts?.runKey,
      ),
      mode,
      [],
      origin,
      runOpts?.isolate ?? false,
      runOpts?.runKey,
      runOpts?.sessionId,
      runOpts?.agentIdOverride,
    );
    return { queued: false };
  };

  // E-DSK-14: let the Telegram controller submit / stop / reset through the
  // same use cases the renderer drives.
  deps.runGateway?.bindSubmit((project, text, opts) =>
    submitInstruction(project, text, [], opts?.mode ?? 'apply', opts?.origin ?? 'remote'));
  deps.runGateway?.bindStop((project) => deps.stopProject.execute(project));
  // Reset the session AND drop its pending queue: a reset starts the
  // conversation from scratch, so any instruction still parked for this
  // session belongs to the old one (e.g. a Telegram `/clean` while a queued
  // message waited). `queue.clear` is a no-op + silent when the queue is empty
  // and emits `queue:changed` otherwise so the renderer queue panel updates.
  // The key is the session identity, same as every other queue op.
  const resetSessionFor = (project: string): boolean => {
    cancelAutoResume(project, 'reset');
    const ok = deps.resetSession.execute(project);
    deps.queue.clear(project);
    return ok;
  };
  // Telegram `/clean`: the use case only resets the main-process registry, so
  // the renderer (owner of the in-memory chat) must be told to clear the
  // visible thread itself — otherwise the next instruction keeps appending to
  // the same session. The renderer-initiated IPC.sessionReset path (chat panel
  // / sidebar) clears its own state, so it does NOT go through this event.
  deps.runGateway?.bindResetSession((project) => {
    const ok = resetSessionFor(project);
    ctx.send('session:reset', { project });
    return ok;
  });

  ctx.ipc.handle(
    IPC.instructionSend,
    (
      _e,
      projectName: string,
      instruction: string,
      attachments: AttachmentPayload[] | undefined,
      // REV-AGENT-CORE-006: optional run mode selected by the composer's
      // segmented control. Validated and defaulted server-side.
      mode?: RunMode,
      // User-facing bubble text when `instruction` is an internal prompt
      // (SDD planner / wake) — replayed on queue:dispatched.
      displayText?: string,
      // T-143: per-pane session identity + worktree isolation. Omitted by the
      // single-pane composer ⇒ identity = projectName.
      runOpts?: { runKey?: string; isolate?: boolean; sessionId?: string; agentIdOverride?: string },
    ): SendInstructionResult => {
      const safeMode: RunMode =
        mode === 'plan' || mode === 'apply' || mode === 'apply-yolo' ? mode : 'apply';
      const safeDisplay = typeof displayText === 'string' && displayText.trim() !== ''
        ? displayText
        : undefined;
      const safeRunOpts =
        runOpts &&
        (typeof runOpts.runKey === 'string' ||
          typeof runOpts.isolate === 'boolean' ||
          typeof runOpts.sessionId === 'string' ||
          typeof runOpts.agentIdOverride === 'string')
          ? {
              ...(typeof runOpts.runKey === 'string' && { runKey: runOpts.runKey }),
              ...(typeof runOpts.isolate === 'boolean' && { isolate: runOpts.isolate }),
              ...(typeof runOpts.sessionId === 'string' && { sessionId: runOpts.sessionId }),
              ...(typeof runOpts.agentIdOverride === 'string' && { agentIdOverride: runOpts.agentIdOverride }),
            }
          : undefined;
      return submitInstruction(
        projectName, instruction, attachments ?? [], safeMode, 'renderer', safeDisplay, safeRunOpts,
      );
    },
  );

  ctx.ipc.handle(IPC.processStop, (_e, projectName: string) => {
    cancelAutoResume(projectName, 'stopped');
    return deps.stopProject.execute(projectName);
  });

  ctx.ipc.handle(IPC.autoResumeCancel, (_e, project: string) => {
    if (typeof project === 'string') cancelAutoResume(project, 'user');
  });

  // REV-AGENT-CORE-001: cancel a specific run by id (no-op if unknown).
  ctx.ipc.handle(IPC.runCancel, (_e, runId: RunId | string) => {
    deps.registry.cancelRun(runId as RunId);
  });

  ctx.ipc.handle(IPC.sessionReset, (_e, projectName: string) =>
    resetSessionFor(projectName));

  ctx.ipc.handle(IPC.processStopAll, () => {
    const stopped = deps.stopAll.execute();
    for (const project of stopped) {
      ctx.send('process:end', { project, code: null, error: 'stopped' });
    }
    return stopped;
  });

  // devia-ui (S-25): the renderer sends the user's resolution of any interface
  // tool here. Same sanitisation as the question channel below — the payload
  // is user input on its way back into an agent's context.
  ctx.ipc.handle(
    IPC.uiToolResult,
    (_e, projectName: string, callId: string, answer: string): void => {
      const safe = String(answer ?? '').slice(0, 10_000).replace(/\0/g, '');
      deps.registry.writeToolResult(projectName, callId, safe);
    },
  );

  // AskUserQuestion multi-turn protocol (TS-CLI-05): the renderer sends the
  // user's answer here; we route it to the running process's stdin.
  ctx.ipc.handle(
    IPC.questionAnswer,
    (_e, projectName: string, toolUseId: string, answer: string): void => {
      // Sanitise at the IPC boundary: cap and strip null bytes.
      // (The launcher also sanitises; this is defence-in-depth.)
      const safe = String(answer ?? '').slice(0, 10_000).replace(/\0/g, '');
      deps.registry.writeToolResult(projectName, toolUseId, safe);
    },
  );

  // FR-4: audit:read — return the last N audit entries to the renderer.
  // Returns only structured metadata; never raw file content.
  ctx.ipc.handle(
    IPC.auditRead,
    (_e, n: number) => deps.auditLog.readLast(typeof n === 'number' && n > 0 ? n : 100),
  );

  return {
    dispose: () => {
      powerMonitor.removeListener('resume', onPowerResume);
      autoResume.dispose();
    },
  };
}

const RUN_FILE_KINDS: ReadonlySet<string> = new Set(['photo', 'video', 'audio', 'document']);

/** Shape check of what the runner forwards for `send_file` (defensive only). */
function isRunFile(value: unknown): value is RunFile {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['path'] === 'string' &&
    typeof v['name'] === 'string' &&
    typeof v['size'] === 'number' &&
    typeof v['mime'] === 'string' &&
    typeof v['kind'] === 'string' &&
    RUN_FILE_KINDS.has(v['kind']) &&
    (v['source'] === 'tool' || v['source'] === 'outbox') &&
    (v['identity'] === undefined || isRunFileIdentity(v['identity']))
  );
}

function isRunFileIdentity(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v['dev'] === 'number' && typeof v['ino'] === 'number';
}
