/**
 * Telegram command router (E-DSK-14 Fase C).
 *
 * Maps an authorised inbound message to an action:
 *   - `/help` | `/start`  → command help
 *   - free text           → run as an instruction in the active project,
 *                           mirrored in the app (the runner emits the user
 *                           bubble + process events) and with the agent's
 *                           reply streamed back to the chat on completion.
 *   - other `/commands`   → reserved for Fase D (project/agent commands).
 *
 * Run output is forwarded by a per-project {@link RunForwarder} that listens to
 * the {@link RunGateway} and replies once the run ends (plus a heartbeat while
 * it works), so the chat shows the agent's answer — not raw stream lines.
 */
import type { ConfigRepository } from '../../../shared/ports';
import type { RunId } from '../../../../shared/domain/agent';
import type { RunEndEvent, RunGateway, RunGatewayEvent } from '../../../shared/run-gateway';
import type { AttachmentPayload } from '../../../../shared/domain/attachment';
import type { GitInfo, GitSyncResult } from '../../../../shared/domain/git';
import type { SessionStats } from '../../../../shared/domain/session-stats';
import type { IncomingMessage, OutboundFile, RemoteMessageHandler } from './telegram-controller';
import { PartialUploadError, describeError } from './telegram-controller';
import { MAX_MEDIA_GROUP } from '../infrastructure/telegram-client';
import { HELP_TEXT } from './commands';
import { foldAssistantText } from './stream-text';
import { attachmentLabel, buildAttachmentInstruction } from './attachment-note';

/** Resolves the project Telegram instructions target. */
export interface ActiveProjectStore {
  /** Current target: an explicit `/use` override, else the app's last project. */
  get(): string | null;
  set(project: string | null): void;
}

/**
 * The active project is `config.lastProjectPath` — the SAME value the desktop
 * persists whenever the user selects a project (AppStateService.selectProject).
 * Reading and writing it here makes the active project fully bidirectional:
 * a `/use` from Telegram updates it (and the app switches), and selecting a
 * project in the app updates it (so the bot follows). No separate override.
 */
export class ConfigActiveProjectStore implements ActiveProjectStore {
  constructor(private readonly config: ConfigRepository) {}
  get(): string | null {
    return this.config.get().lastProjectPath || null;
  }
  set(project: string | null): void {
    this.config.set({ lastProjectPath: project ?? '' });
  }
}

/** Minimal project info the router needs for `/projects` and `/use`. */
export interface RemoteProjectInfo {
  path: string;
  name: string;
  /** True for a runnable project (has a tech marker); false for a plain
   *  container folder that only holds other projects. */
  runnable: boolean;
}

/** Cross-feature operations the router needs, wired in the composition root so
 *  the telegram feature stays decoupled from workspace/claude-runner. */
export interface RemoteCommandPorts {
  /** Immediate child folders of `subpath` (relative to the workspace root), or
   *  of the root when omitted — each flagged runnable or container. */
  listProjects(subpath?: string): Promise<RemoteProjectInfo[]> | RemoteProjectInfo[];
  /** Whether a relative path is a runnable project (vs a container folder). */
  isRunnable?(path: string): boolean;
  /** Persist a downloaded attachment to disk, returning its absolute path.
   *  Absent → attachments disabled (the feature stays decoupled). */
  saveAttachment?(payload: AttachmentPayload): string;
  isRunning(project: string): boolean;
  /** Short label of the active agent/model, for `/status`. */
  agentLabel(): string;
  /** Git branch + working-tree state of a project (relative path), for
   *  `/status`. Absent → git line omitted; `null` → not a git repo. Keeps the
   *  feature decoupled from the git inspector. */
  gitInfo?(project: string): GitInfo | null;
  /** Active-session stats rollup (context + cost) of a project, for `/status`
   *  (S-7). Absent or `null` → the context/cost lines are omitted. */
  sessionStats?(project: string): SessionStats | null;
  /** Switch the project to its default branch and `git pull --ff-only`, for
   *  `/sync`. Absent → /sync replies that the integration is unavailable.
   *  Mirrors the desktop footer sync button. */
  syncGit?(project: string): Promise<GitSyncResult>;
  /** Whether shell passthrough (/exec, !) is enabled (config gate, off by default). */
  allowShell(): boolean;
  /** Run a shell command in the project directory. Absent → feature disabled. */
  runShell?(project: string, command: string): Promise<{ code: number | null; output: string; timedOut: boolean }>;
}

export interface CommandRouterDeps {
  gateway: RunGateway;
  activeProject: ActiveProjectStore;
  ports: RemoteCommandPorts;
  /** Injectable clock (ms) for the heartbeat. */
  now?: () => number;
  /** Heartbeat period in ms while a run is in flight (default 2 min). */
  heartbeatMs?: number;
  /** Push an unsolicited message to the chat — used by the desktop → chat run
   *  mirror. Absent → mirroring disabled (the feature stays decoupled). */
  pushChat?: (text: string) => Promise<void>;
  /** Whether desktop-initiated runs are mirrored to the chat (config gate). */
  mirrorDesktop?: () => boolean;
  /** Notify that `/use` activated a (runnable) project, so the desktop app can
   *  switch to it and show it as active. */
  onActiveProjectChange?: (project: string) => void;
  /** Upload files to the chat for the desktop → chat mirror (S-32). Absent →
   *  a mirrored run's files are not forwarded. */
  pushChatFile?: (file: OutboundFile) => Promise<void>;
  pushChatFiles?: (files: readonly OutboundFile[]) => Promise<void>;
  /** Per-file delivery outcome, wired to the audit log (S-32). */
  onFileOutcome?: FileOutcomeFn;
}

type ReplyFn = (text: string) => Promise<void>;

/** Where a forwarder uploads the run's files: the originating chat
 *  (`replyFile(s)`) or, for the desktop mirror, `pushFile(s)`. */
export interface FileSink {
  sendFile(file: OutboundFile): Promise<void>;
  sendFiles(files: readonly OutboundFile[]): Promise<void>;
}

export type FileOutcome = 'delivered' | `failed:${string}`;

export interface FileOutcomeContext {
  project: string;
  agentId?: string;
  runId?: RunId;
}

export type FileOutcomeFn = (ctx: FileOutcomeContext, file: OutboundFile, outcome: FileOutcome) => void;

interface ForwarderOptions {
  files?: FileSink;
  onFileOutcome?: FileOutcomeFn;
}

/** Split a run's files into Telegram-compatible uploads, in send order:
 *  photo/video albums, then documents, then audio. A batch of one is sent as a
 *  single file; anything larger is an album of at most `MAX_MEDIA_GROUP`.
 *  No photo is over Telegram's 10 MB photo cap here: the gate
 *  (`revalidateOutboundFile`, used by both the tool and the outbox) downgrades
 *  such a photo to `document`, and the upload refuses a file whose size changed
 *  since validation. */
export function planFileBatches(files: readonly OutboundFile[]): OutboundFile[][] {
  const visual = files.filter((f) => f.kind === 'video' || f.kind === 'photo');
  const docs = files.filter((f) => f.kind === 'document');
  const audio = files.filter((f) => f.kind === 'audio');
  return [...chunk(visual), ...chunk(docs), ...chunk(audio)];
}

function chunk(files: readonly OutboundFile[]): OutboundFile[][] {
  const out: OutboundFile[][] = [];
  for (let i = 0; i < files.length; i += MAX_MEDIA_GROUP) out.push(files.slice(i, i + MAX_MEDIA_GROUP));
  return out;
}

const DEFAULT_HEARTBEAT_MS = 2 * 60 * 1000;

type RemoteRunMode = 'plan' | 'apply' | 'apply-yolo';

const MODE_LABEL: Record<RemoteRunMode, string> = {
  plan: 'plan (solo lectura)',
  apply: 'apply (aplica cambios)',
  'apply-yolo': 'yolo (sin permisos) ⚡',
};

/** Last path segment, for compact chat labels. */
function leaf(project: string): string {
  return project.split('/').pop() ?? project;
}

/** One-line git branch + working-tree state for `/status`. `null` means the
 *  active project is not a git repository. */
function formatBranch(info: GitInfo | null): string {
  if (!info) return '🌿 Rama: _(sin repositorio git)_';
  const state = info.dirty ? '● con cambios sin confirmar' : '✓ limpia';
  const note =
    info.defaultBranch && info.branch !== info.defaultBranch
      ? ` _(por defecto: ${info.defaultBranch})_`
      : '';
  return `🌿 Rama: \`${info.branch}\` · ${state}${note}`;
}

/** Compact thousands grouping for token counts in chat (e.g. 250.000). */
function fmtNum(n: number): string {
  return n.toLocaleString('es-ES');
}

/** Context-usage % and accumulated cost lines for `/status` (S-7) — plain
 *  numbers, no progress bars. The context line is omitted when the session
 *  reported no token usage (e.g. non-Claude CLIs); the cost line always shows. */
function formatSessionStats(stats: SessionStats): string[] {
  const lines: string[] = [];
  if (stats.contextTokens !== undefined) {
    if (stats.contextWindow && stats.contextWindow > 0) {
      const pct = Math.round(Math.min(stats.contextTokens / stats.contextWindow, 1) * 100);
      lines.push(`🧠 Contexto: ${pct}% · ${fmtNum(stats.contextTokens)} / ${fmtNum(stats.contextWindow)} tokens`);
    } else {
      lines.push(`🧠 Contexto: ${fmtNum(stats.contextTokens)} tokens`);
    }
  }
  lines.push(`💸 Gasto: $${stats.costUsd.toFixed(4)}`);
  return lines;
}

/**
 * Streams one project's run progress back to the chat. Accumulates the latest
 * assistant text (and the files the run asked to deliver) and sends them once
 * the router calls `finish()` after `end`, with a periodic heartbeat so long
 * runs show life. One instance per active project; replaced reply target when a
 * newer message arrives for the same project.
 */
export class RunForwarder {
  private latest = '';
  private reply: ReplyFn;
  private files: FileSink | undefined;
  private readonly onFileOutcome: FileOutcomeFn | undefined;
  private readonly pendingFiles = new Map<string, { file: OutboundFile; runId?: RunId }>();
  /** Files the main process refused to relay (T-367 `file_rejected`). */
  private rejected: string[] = [];
  private agentId: string | undefined;
  private timer: ReturnType<typeof setInterval> | null = null;
  private startedMs: number;

  constructor(
    private readonly project: string,
    reply: ReplyFn,
    private readonly now: () => number,
    private readonly heartbeatMs: number,
    options: ForwarderOptions = {},
  ) {
    this.reply = reply;
    this.files = options.files;
    this.onFileOutcome = options.onFileOutcome;
    this.startedMs = now();
  }

  setReply(reply: ReplyFn, files?: FileSink): void {
    this.reply = reply;
    if (files) this.files = files;
  }

  handle(event: RunGatewayEvent): void {
    if (event.project !== this.project) return;
    if (event.type === 'start') {
      this.startedMs = this.now();
      if (event.agentId !== undefined) this.agentId = event.agentId;
      this.startHeartbeat();
    } else if (event.type === 'output') {
      this.latest = foldAssistantText(event.line, this.latest);
    } else if (event.type === 'file') {
      // Without a sink the file has nowhere to go; dropping it keeps a run
      // that cannot upload byte-identical to the pre-S-32 reply.
      if (this.files && !this.pendingFiles.has(event.file.path)) {
        this.pendingFiles.set(event.file.path, {
          file: event.file,
          ...(event.runId !== undefined && { runId: event.runId }),
        });
      }
    } else if (event.type === 'file_rejected') {
      if (this.files) this.rejected.push(`${event.name} (${event.reason})`);
    } else if (event.type === 'end') {
      this.stopHeartbeat();
    }
  }

  dispose(): void {
    this.stopHeartbeat();
  }

  /**
   * Final reply, then the run's files. Files are sent even when the run ended
   * in error: each one was already validated when the agent asked for it, and
   * a later failure in the run doesn't make a finished report less useful. A
   * STOPPED run is different: the user (from the chat or the app) asked it to
   * stop, so nothing more leaves the machine — its pending files are only
   * announced as not sent and audited `failed:stopped`.
   */
  async finish(code: number | null, error?: string, stopped = error === 'stopped'): Promise<void> {
    // The agent's reply is always labelled with the project it ran in, so the
    // chat stays unambiguous across projects (E-DSK-14).
    const label = `*[${leaf(this.project)}]*`;
    const body = this.latest.trim() || '_(sin texto de respuesta)_';
    const footer = stopped
      ? '\n\n⏹️ *Detenido*'
      : error
        ? `\n\n❌ *Error* (${error})`
        : `\n\n✅ *Completado* (código ${code ?? 0})`;
    const pending = [...this.pendingFiles.values()];
    this.pendingFiles.clear();
    const rejected = this.rejected;
    this.rejected = [];
    const attached = pending.length > 0 && !stopped ? `\n📎 ${pending.length} archivo(s) a continuación` : '';
    try {
      await this.reply(`${label}\n${body}${footer}${attached}`);
    } catch {
      /* the files still go: the text failing doesn't make them unwanted */
    }
    if (stopped && pending.length > 0) {
      for (const p of pending) this.reportOutcome(p.file, p.runId, 'failed:stopped');
      await this.reply(`⏹️ Ejecución detenida: no envié ${pending.length} archivo(s)`).catch(() => { /* best effort */ });
    }
    const failures = [...rejected, ...(stopped ? [] : await this.flushFiles(pending))];
    if (failures.length > 0) {
      await this.reply(`⚠️ No pude enviar: ${failures.join(', ')}`).catch(() => { /* best effort */ });
    }
  }

  /** Uploads every batch; one failing never aborts the rest. Returns the
   *  failures as `name (reason)` labels. */
  private async flushFiles(pending: { file: OutboundFile; runId?: RunId }[]): Promise<string[]> {
    const sink = this.files;
    if (!sink || pending.length === 0) return [];
    const runIds = new Map(pending.map((p) => [p.file.path, p.runId]));
    const failures: string[] = [];
    for (const batch of planFileBatches(pending.map((p) => p.file))) {
      // Per-file outcome: a `PartialUploadError` says which files of the batch
      // failed (the rest went through); any other error failed them all.
      let failedOf: (f: OutboundFile) => unknown = () => undefined;
      try {
        const [only] = batch;
        if (batch.length === 1 && only) await sink.sendFile(only);
        else await sink.sendFiles(batch);
      } catch (err) {
        failedOf = err instanceof PartialUploadError ? (f) => err.failures.get(f.path) : () => err;
      }
      for (const f of batch) {
        const err = failedOf(f);
        let outcome: FileOutcome = 'delivered';
        if (err !== undefined) {
          const reason = describeError(err);
          outcome = `failed:${reason}`;
          failures.push(`${f.name} (${reason})`);
        }
        this.reportOutcome(f, runIds.get(f.path), outcome);
      }
    }
    return failures;
  }

  private reportOutcome(file: OutboundFile, runId: RunId | undefined, outcome: FileOutcome): void {
    if (!this.onFileOutcome) return;
    try {
      this.onFileOutcome(
        {
          project: this.project,
          ...(this.agentId !== undefined && { agentId: this.agentId }),
          ...(runId !== undefined && { runId }),
        },
        file,
        outcome,
      );
    } catch {
      /* auditing must never break delivery */
    }
  }

  private startHeartbeat(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      const minutes = Math.max(1, Math.round((this.now() - this.startedMs) / 60000));
      void this.reply(`⏳ Sigo trabajando en *${leaf(this.project)}*… (${minutes} min)`);
    }, this.heartbeatMs);
    this.timer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

/**
 * Did the user stop this run (`/stop` in the chat, or Stop in the app)? A user
 * stop reaches the runner's `onError` as `cancelReason: 'user'` (label
 * "Cancelado por ti."); the end event carries it as `cancelReason` once the
 * runner publishes it, and the legacy `'stopped'` error is accepted too. Idle /
 * question timeouts are NOT user stops: those runs still deliver their files.
 */
function stoppedByUser(event: RunEndEvent): boolean {
  const { cancelReason } = event as RunEndEvent & { cancelReason?: string };
  return event.error === 'stopped' || cancelReason === 'user';
}

/** The originating chat's file uploads, when the message carries them. */
function fileSinkOf(msg: Pick<IncomingMessage, 'replyFile' | 'replyFiles'>): FileSink | undefined {
  const { replyFile, replyFiles } = msg;
  return replyFile && replyFiles ? { sendFile: replyFile, sendFiles: replyFiles } : undefined;
}

export function createCommandRouter(deps: CommandRouterDeps): RemoteMessageHandler {
  const now = deps.now ?? Date.now;
  const heartbeatMs = deps.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const forwarders = new Map<string, RunForwarder>();
  // Per-project tail of finished-but-still-uploading runs: the next run's
  // final reply waits for the previous run's files, so the chat stays ordered.
  const tails = new Map<string, Promise<void>>();
  const mirrorFiles: FileSink | undefined =
    deps.pushChatFile && deps.pushChatFiles
      ? { sendFile: deps.pushChatFile, sendFiles: deps.pushChatFiles }
      : undefined;
  const forwarderOptions = (files: FileSink | undefined): ForwarderOptions => ({
    ...(files !== undefined && { files }),
    ...(deps.onFileOutcome !== undefined && { onFileOutcome: deps.onFileOutcome }),
  });
  // Permission mode applied to remote runs. Adjustable via /mode.
  let runMode: RemoteRunMode = 'apply';

  // One subscription routes every run event to the matching project forwarder.
  // A run started from the app has no forwarder (Telegram-initiated runs
  // register one before submitting); when desktop mirroring is on we create one
  // on its `start`, pushing the user prompt first so the chat shows both sides.
  deps.gateway.subscribe((event) => {
    let forwarder = forwarders.get(event.project);
    if (
      !forwarder &&
      event.type === 'start' &&
      event.text &&
      deps.pushChat &&
      deps.mirrorDesktop?.()
    ) {
      const push = deps.pushChat;
      forwarder = new RunForwarder(event.project, push, now, heartbeatMs, forwarderOptions(mirrorFiles));
      forwarders.set(event.project, forwarder);
      void push(`👤 *[${leaf(event.project)}]* ${event.text}`);
    }
    if (!forwarder) return;
    forwarder.handle(event);
    if (event.type === 'end') {
      // Unmapped now so a new run gets a fresh forwarder, but only disposed
      // once its reply and uploads are done (finish is async).
      forwarders.delete(event.project);
      const done = forwarder;
      const tail = (tails.get(event.project) ?? Promise.resolve())
        .then(() => done.finish(event.code, event.error, stoppedByUser(event)))
        .catch(() => { /* a failed reply must not break the chain */ })
        .finally(() => done.dispose());
      tails.set(event.project, tail);
      void tail.then(() => {
        if (tails.get(event.project) === tail) tails.delete(event.project);
      });
    }
  });

  // Run an instruction in a project, registering a forwarder first so a
  // synchronous run start is never missed.
  const runInstruction = async (project: string, text: string, msg: IncomingMessage): Promise<void> => {
    const reply = msg.reply;
    const files = fileSinkOf(msg);
    const existing = forwarders.get(project);
    if (existing) existing.setReply(reply, files);
    else forwarders.set(project, new RunForwarder(project, reply, now, heartbeatMs, forwarderOptions(files)));

    let result;
    try {
      result = deps.gateway.submit(project, text, { origin: 'remote', mode: runMode });
    } catch {
      forwarders.delete(project);
      await reply('No se pudo lanzar la instrucción (el motor de ejecución no está listo).');
      return;
    }
    await reply(
      result.queued
        ? `🕒 Encolada (#${result.position ?? '?'}) en *${leaf(project)}*.`
        : `▶️ Ejecutando en *${leaf(project)}*…`,
    );
  };

  // Save the message's attachments and run the caption as an instruction that
  // points the agent at each downloaded file (read with its Read tool).
  const runWithAttachments = async (msg: IncomingMessage): Promise<void> => {
    const project = deps.activeProject.get();
    if (!project) {
      await msg.reply('No hay proyecto activo. Abre un proyecto en Devia o usa /use <proyecto>.');
      return;
    }
    const save = deps.ports.saveAttachment;
    if (!save) {
      await msg.reply('Los adjuntos no están disponibles en esta versión.');
      return;
    }
    const files = (msg.attachments ?? []).map((a) => ({
      label: attachmentLabel(a.kind, a.mime),
      path: save({ name: a.name, mime: a.mime, buffer: a.buffer }),
    }));
    const instruction = buildAttachmentInstruction(msg.text.trim(), files);
    await runInstruction(project, instruction, msg);
  };

  // Resolve a `/use`/`/stop`/`/clean` argument to a project entry: an exact
  // relative path (supports nested folders like `Eviatech/devia`), a unique
  // leaf name at the root, or — when omitted — the current active project.
  const resolveProject = async (arg: string | undefined): Promise<RemoteProjectInfo | null> => {
    if (!arg) {
      const p = deps.activeProject.get();
      return p ? { path: p, name: leaf(p), runnable: deps.ports.isRunnable?.(p) ?? true } : null;
    }
    const normalized = arg.replace(/^\/+|\/+$/g, '');
    const slash = normalized.lastIndexOf('/');
    const parent = slash >= 0 ? normalized.slice(0, slash) : '';
    const siblings = await deps.ports.listProjects(parent);
    const exact = siblings.find((p) => p.path === normalized);
    if (exact) return exact;
    const root = parent === '' ? siblings : await deps.ports.listProjects('');
    const byName = root.filter((p) => p.name === normalized);
    return byName.length === 1 ? (byName[0] ?? null) : null;
  };

  // Gated shell passthrough (/exec, !). Off by default.
  const handleExec = async (command: string, reply: ReplyFn): Promise<void> => {
    if (!command) {
      await reply('Uso: /exec `<comando>` o `!<comando>`.');
      return;
    }
    if (!deps.ports.allowShell() || !deps.ports.runShell) {
      await reply('🔒 Los comandos de shell están desactivados. Actívalos en Ajustes › Control remoto.');
      return;
    }
    const project = deps.activeProject.get();
    if (!project) {
      await reply('No hay proyecto activo para ejecutar el comando.');
      return;
    }
    await reply(`⚙️ Ejecutando en *${leaf(project)}*: \`${command}\``);
    const res = await deps.ports.runShell(project, command);
    const tail = res.output.trim().slice(-3500) || '(sin salida)';
    const status = res.timedOut ? '⏱️ Timeout' : `código ${res.code ?? 0}`;
    await reply('```\n' + tail + '\n```\n' + status);
  };

  return async (msg: IncomingMessage): Promise<void> => {
    // Media messages carry a caption (the instruction) + downloaded files.
    if (msg.attachments && msg.attachments.length > 0) {
      await runWithAttachments(msg);
      return;
    }

    const text = msg.text.trim();
    if (!text) return;

    // `!command` shorthand for /exec.
    if (text.startsWith('!')) {
      await handleExec(text.slice(1).trim(), msg.reply);
      return;
    }

    // Free text → instruction in the active project.
    if (!text.startsWith('/')) {
      const project = deps.activeProject.get();
      if (!project) {
        await msg.reply('No hay proyecto activo. Abre un proyecto en Devia o usa /use <proyecto>.');
        return;
      }
      await runInstruction(project, text, msg);
      return;
    }

    const parts = text.split(/\s+/);
    const cmd = parts[0];
    const arg = parts.slice(1).join(' ').trim() || undefined;

    switch (cmd) {
      case '/help':
      case '/start':
        await msg.reply(HELP_TEXT);
        return;

      case '/projects': {
        const active = deps.activeProject.get();
        // Browse into the active folder only when it's a container (not a
        // runnable project); otherwise list the workspace root.
        const base = active && deps.ports.isRunnable && !deps.ports.isRunnable(active) ? active : '';
        const projects = await deps.ports.listProjects(base);
        const header = base ? `📁 *Contenido de* \`${base}\`` : '📁 *Proyectos*';
        const lines: string[] = [];
        if (base) {
          const slash = base.lastIndexOf('/');
          const parent = slash >= 0 ? base.slice(0, slash) : '';
          lines.push(parent ? `⬆️ \`/use ${parent}\`` : '⬆️ `/use` _(volver a la raíz)_');
        }
        if (projects.length === 0) {
          lines.push(base ? '_(sin subcarpetas)_' : '_(no hay proyectos en el workspace)_');
        } else {
          for (const p of projects) {
            const icon = p.runnable ? '📦' : '📂';
            const marks = `${p.path === active ? '➡️ ' : ''}${deps.ports.isRunning(p.path) ? '🟢 ' : ''}`;
            lines.push(`${icon} ${marks}\`/use ${p.path}\``);
          }
        }
        await msg.reply(`${header}\n${lines.join('\n')}`);
        return;
      }

      case '/use': {
        if (!arg) {
          // No argument returns to the workspace root: it clears the active
          // project so navigation starts fresh. This implements the
          // `⬆️ /use (volver a la raíz)` hint shown by /projects — without it
          // there was no way to deselect a project once one was active.
          if (deps.activeProject.get()) deps.activeProject.set(null);
          await msg.reply('🏠 De vuelta en la raíz. Sin proyecto activo.\nUsa /projects para elegir un proyecto.');
          return;
        }
        const resolved = await resolveProject(arg);
        if (!resolved) {
          await msg.reply(`No encuentro el proyecto \`${arg}\`. Usa /projects para ver la lista.`);
          return;
        }
        deps.activeProject.set(resolved.path);
        // Switch the desktop app to the project too (only for real projects;
        // a container folder is just navigation context for /projects).
        if (resolved.runnable) deps.onActiveProjectChange?.(resolved.path);
        await msg.reply(
          resolved.runnable
            ? `✅ Proyecto activo: *${leaf(resolved.path)}*`
            : `📂 Seleccionada *${leaf(resolved.path)}* — es una carpeta, no un proyecto ejecutable.\nUsa /projects para ver lo que contiene.`,
        );
        return;
      }

      case '/status': {
        const project = deps.activeProject.get();
        const agent = deps.ports.agentLabel();
        if (!project) {
          await msg.reply(`Sin proyecto activo.\nAgente: ${agent}\nModo: ${MODE_LABEL[runMode]}`);
          return;
        }
        const running = deps.ports.isRunning(project) ? '🟢 ejecutando' : '⚪ inactivo';
        const lines = [`*Estado*`, `Proyecto: *${leaf(project)}*`];
        // gitInfo is optional (decoupled): undefined → omit the line, null →
        // "no git repo", otherwise show branch + dirty state.
        const git = deps.ports.gitInfo?.(project);
        if (git !== undefined) lines.push(formatBranch(git));
        lines.push(running, `Agente: ${agent}`, `Modo: ${MODE_LABEL[runMode]}`);
        // S-7: context usage % + accumulated cost of the active session.
        const stats = deps.ports.sessionStats?.(project);
        if (stats) lines.push(...formatSessionStats(stats));
        await msg.reply(lines.join('\n'));
        return;
      }

      case '/sync': {
        const project = deps.activeProject.get();
        if (!project) {
          await msg.reply('Sin proyecto activo. Usa /use `<ruta>`.');
          return;
        }
        const sync = deps.ports.syncGit;
        if (!sync) {
          await msg.reply('La sincronización git no está disponible.');
          return;
        }
        // Precondition check matches StatusbarComponent.canSync so /sync only
        // runs when the footer button would too (no surprises from remote).
        const info = deps.ports.gitInfo?.(project) ?? null;
        if (!info) {
          await msg.reply(`*${leaf(project)}* no es un repositorio git.`);
          return;
        }
        if (!info.defaultBranch) {
          await msg.reply(
            `No se ha detectado la rama principal de *${leaf(project)}*. Haz \`git fetch\` y reintenta.`,
          );
          return;
        }
        if (info.branch === info.defaultBranch) {
          await msg.reply(`Ya estás en \`${info.defaultBranch}\` en *${leaf(project)}*. Nada que sincronizar.`);
          return;
        }
        if (info.dirty) {
          await msg.reply(
            `*${leaf(project)}* tiene cambios sin confirmar en \`${info.branch}\`. Commitea o haz stash antes de sincronizar.`,
          );
          return;
        }
        await msg.reply(
          `🔄 Sincronizando *${leaf(project)}*: \`${info.branch}\` → \`${info.defaultBranch}\`…`,
        );
        const result = await sync(project);
        if (result.ok) {
          await msg.reply(`✅ ${result.message}`);
        } else {
          const tail = result.message ? `\n\`\`\`\n${result.message}\n\`\`\`` : '';
          await msg.reply(`❌ Sync falló.${tail}`);
        }
        return;
      }

      case '/mode': {
        const map: Record<string, RemoteRunMode> = {
          plan: 'plan',
          apply: 'apply',
          yolo: 'apply-yolo',
          'apply-yolo': 'apply-yolo',
        };
        if (!arg) {
          await msg.reply(`Modo actual: ${MODE_LABEL[runMode]}\nUsa /mode plan|apply|yolo.`);
          return;
        }
        const next = map[arg.toLowerCase()];
        if (!next) {
          await msg.reply('Modo no válido. Usa /mode plan|apply|yolo.');
          return;
        }
        runMode = next;
        await msg.reply(`✅ Modo: ${MODE_LABEL[runMode]}`);
        return;
      }

      case '/agent': {
        await msg.reply(`Agente activo: *${deps.ports.agentLabel()}*\nCámbialo desde la app (Ajustes › Agente).`);
        return;
      }

      case '/exec': {
        await handleExec(arg ?? '', msg.reply);
        return;
      }

      case '/stop': {
        const target = await resolveProject(arg);
        if (!target) {
          await msg.reply('No hay proyecto que detener. Indica /stop <proyecto> o selecciona uno.');
          return;
        }
        const { path: project } = target;
        const wasRunning = deps.ports.isRunning(project);
        deps.gateway.stop(project);
        await msg.reply(wasRunning ? `⏹️ Detenido *${leaf(project)}*.` : `No había nada en ejecución en *${leaf(project)}*.`);
        return;
      }

      case '/clean': {
        const target = await resolveProject(arg);
        if (!target) {
          await msg.reply('Indica /clean <proyecto> o selecciona uno activo.');
          return;
        }
        const { path: project } = target;
        deps.gateway.resetSession(project);
        await msg.reply(`🧹 Sesión reiniciada en *${leaf(project)}*. La próxima instrucción empieza de cero.`);
        return;
      }

      default:
        await msg.reply(`Comando no reconocido: ${cmd}. Usa /help.`);
    }
  };
}
