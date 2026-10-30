/**
 * Telegram controller (E-DSK-14) — the policy layer of the embedded remote
 * control. Owns the connection lifecycle (start/stop/restart), the
 * connection-status reporting, the chat-id allowlist, and the dispatch of
 * authorised messages to the injected command handler.
 *
 * No daemon: it runs inside the Electron main process, started on `onReady`
 * when `config.remoteControl.telegram.enabled` and stopped on `onBeforeQuit`
 * (or when the user toggles it off and the renderer calls `restart`).
 */
import { constants as fsConstants, promises as fsp } from 'node:fs';
import type { ConfigRepository } from '../../../shared/ports';
import type { RunFile } from '../../../shared/run-gateway';
import type { RemoteControlStatus, TelegramTestResult } from '../../../../shared/domain/remote-control';
import {
  MAX_UPLOAD_BYTES,
  TelegramClient,
  TelegramApiError,
  type MediaGroupItems,
  type TelegramUpdate,
  type TelegramMessage,
  type TelegramUploadFile,
} from '../infrastructure/telegram-client';
import { TelegramPoller } from '../infrastructure/telegram-poller';
import { attachmentLabel, type RemoteMediaKind } from './attachment-note';
import { BOT_COMMANDS } from './commands';

/** How long to wait for the rest of a media album (Telegram sends each item in
 *  the group as a separate update sharing one `media_group_id`). */
const DEFAULT_MEDIA_GROUP_MS = 700;

/** Greeting pushed to the chat when the controller connects (app launch or
 *  settings restart) so the user knows Devia is live and listening. */
const CONNECTED_NOTICE =
  '🟢 *Devia conectado* — escuchando en este chat. Escribe /help para ver los comandos.';

/** A downloaded Telegram attachment handed to the command handler. */
export interface RemoteAttachment {
  /** Suggested filename (document name, or a generated one for photos). */
  name: string;
  mime: string;
  kind: RemoteMediaKind;
  buffer: ArrayBuffer;
}

/** A file to upload to the chat: a `RunFile` the main process already
 *  revalidated (S-32). Read from disk right before the upload, never copied. */
export type OutboundFile = RunFile;

/** The `fstat` fields the upload-time check needs (a subset of `fs.Stats`). */
export interface OutboundFileStat {
  isFile(): boolean;
  nlink: number;
  size: number;
  dev: number;
  ino: number;
}

/** The slice of `fs.promises.FileHandle` the upload reader uses — the test seam. */
export interface OutboundFileHandle {
  stat(): Promise<OutboundFileStat>;
  read(buffer: Uint8Array, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}

export type OpenOutboundFile = (path: string) => Promise<OutboundFileHandle>;

/** Why an outbound file was refused at upload time (or why the relay could
 *  not upload at all). Surfaces through `describeError` as the reason itself. */
export type OutboundUploadRefusal = 'changed' | 'hardlink' | 'not-a-file' | 'too-large' | 'not-connected';

export class OutboundUploadError extends Error {
  constructor(readonly reason: OutboundUploadRefusal) {
    super(`outbound upload refused: ${reason}`);
    this.name = 'OutboundUploadError';
  }
}

/**
 * A batch where only some files failed. `failures` is keyed by `RunFile.path`;
 * every other file of the batch was delivered.
 */
export class PartialUploadError extends Error {
  constructor(readonly failures: ReadonlyMap<string, unknown>) {
    super(`${failures.size} file(s) failed to upload`);
    this.name = 'PartialUploadError';
  }
}

/** `O_NOFOLLOW` makes `open` fail with ELOOP when the final path component is
 *  a symlink — a file swapped for a link after validation is never followed.
 *  Not defined on Windows, where it degrades to a plain read-only open. */
const OPEN_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);

const openNoFollow: OpenOutboundFile = (path) => fsp.open(path, OPEN_FLAGS);

/**
 * Read an outbound file for upload, re-checking it on the OPEN HANDLE so
 * nothing can be swapped between the check and the read (S-32): it must be a
 * regular file with a single link, the very inode validated (when the gate
 * captured it), exactly the validated size, and within Telegram's cap. Reads
 * exactly `size` bytes from the handle; never `readFile` on the path.
 */
export async function readOutboundFile(
  file: OutboundFile,
  open: OpenOutboundFile = openNoFollow,
): Promise<Uint8Array> {
  const handle = await open(file.path);
  try {
    const st = await handle.stat();
    if (!st.isFile()) throw new OutboundUploadError('not-a-file');
    if (st.nlink !== 1) throw new OutboundUploadError('hardlink');
    const id = file.identity;
    if (id && (st.dev !== id.dev || st.ino !== id.ino)) throw new OutboundUploadError('changed');
    if (st.size !== file.size) throw new OutboundUploadError('changed');
    if (st.size > MAX_UPLOAD_BYTES) throw new OutboundUploadError('too-large');
    const data = new Uint8Array(st.size);
    let offset = 0;
    while (offset < data.length) {
      const { bytesRead } = await handle.read(data, offset, data.length - offset, offset);
      if (bytesRead === 0) throw new OutboundUploadError('changed'); // truncated under us
      offset += bytesRead;
    }
    return data;
  } finally {
    await handle.close().catch(() => { /* nothing useful to do */ });
  }
}

/** An authorised inbound message handed to the command handler. */
export interface IncomingMessage {
  chatId: number;
  text: string;
  messageId: number;
  /** Unix seconds. */
  date: number;
  /** Downloaded media that came with the message (photos, PDFs, docs, …). */
  attachments?: RemoteAttachment[];
  /** Send a text reply to the originating chat (chunked + markdown-safe). */
  reply(text: string): Promise<void>;
  /** Upload one file to the authorised chat. Rejects on failure (missing
   *  file, changed since validation, Telegram error) so the caller can report it. */
  replyFile?(file: OutboundFile): Promise<void>;
  /** Upload 2–10 files as one album (homogeneous: photos+videos, documents or
   *  audio); one file degrades to `replyFile`. Rejects on failure — with a
   *  `PartialUploadError` when only some of the files failed. */
  replyFiles?(files: readonly OutboundFile[]): Promise<void>;
}

export type RemoteMessageHandler = (msg: IncomingMessage) => Promise<void> | void;

export interface TelegramControllerDeps {
  config: ConfigRepository;
  /** Emit a status change to the renderer (wired to `remoteControl:status`). */
  emitStatus: (status: RemoteControlStatus) => void;
  /** Handles an authorised message. Defaults to a help/ack handler; Fase C
   *  injects the real command router. */
  onMessage?: RemoteMessageHandler;
  /** Client factory — overridable in tests. */
  createClient?: (token: string) => TelegramClient;
  /** Injectable clock (ms). */
  now?: () => number;
  /** Album debounce window in ms (default 700). Lowered in tests. */
  mediaGroupMs?: number;
  /** Called when the bot connects (poller running) and when it stops. The
   *  feature wires these to a `powerSaveBlocker` so the OS doesn't idle-sleep
   *  the app — and freeze the long-poll — while the remote control is live. */
  onActive?: () => void;
  onInactive?: () => void;
  /** Opens an outbound file for upload (default: `O_RDONLY | O_NOFOLLOW`) —
   *  overridable in tests. */
  openFile?: OpenOutboundFile;
}

/** A media item pending download, extracted from an inbound message. */
interface PendingMedia {
  fileId: string;
  kind: RemoteMediaKind;
  filename?: string;
  mime?: string;
}

interface MediaGroup {
  items: PendingMedia[];
  caption: string;
  chatId: number;
  messageId: number;
  date: number;
  timer?: ReturnType<typeof setTimeout>;
}

export class TelegramController {
  private client: TelegramClient | null = null;
  private poller: TelegramPoller | null = null;
  private status: RemoteControlStatus = { state: 'disabled' };
  private allowedChatId = 0;
  /** Unix seconds at connection time; messages older than this are ignored. */
  private startedAtSec = 0;
  /** In-flight media albums, keyed by `media_group_id`. */
  private readonly groupBuffers = new Map<string, MediaGroup>();

  constructor(private readonly deps: TelegramControllerDeps) {}

  getStatus(): RemoteControlStatus {
    return this.status;
  }

  /** Validate a token without enabling it (Settings "Probar conexión"). */
  async testToken(token: string): Promise<TelegramTestResult> {
    const trimmed = token.trim();
    if (!trimmed) return { ok: false, error: 'empty-token' };
    try {
      const me = await this.makeClient(trimmed).getMe();
      return me.username !== undefined
        ? { ok: true, botUsername: me.username }
        : { ok: true };
    } catch (err) {
      return { ok: false, error: describeError(err) };
    }
  }

  /** Stop any running connection, then start fresh if config enables it. */
  async restart(): Promise<RemoteControlStatus> {
    this.stop();
    await this.start();
    return this.status;
  }

  /** Start the controller if config enables Telegram and has token + chat id. */
  async start(): Promise<void> {
    const tg = this.deps.config.get().remoteControl.telegram;
    if (!tg.enabled || !tg.botToken.trim() || !tg.chatId.trim()) {
      this.setStatus({ state: 'disabled' });
      return;
    }
    const chatId = Number(tg.chatId.trim());
    if (!Number.isFinite(chatId)) {
      this.setStatus({ state: 'error', detail: 'invalid-chat-id' });
      return;
    }

    this.setStatus({ state: 'connecting' });
    this.allowedChatId = chatId;
    this.client = this.makeClient(tg.botToken.trim());

    let username: string | undefined;
    try {
      username = (await this.client.getMe()).username;
    } catch (err) {
      this.client = null;
      this.setStatus(
        err instanceof TelegramApiError && err.authError
          ? { state: 'auth-error', detail: describeError(err) }
          : { state: 'error', detail: describeError(err) },
      );
      return;
    }

    // Keep the native Telegram `/` suggestion menu in sync with `/help`.
    // Always register at `chat` scope (not `default`) so a stale list at a
    // more-specific scope from a previous bot owner can't override us — and
    // so re-running BotFather's `/setcommands` (which writes to `default`)
    // never fights us back. Best effort: a failed registration must not
    // abort startup. Re-registering on every connect is idempotent.
    void this.client
      .setMyCommands(BOT_COMMANDS, { scope: { type: 'chat', chat_id: chatId } })
      .catch((err: unknown) => {
        console.warn('[telegram] setMyCommands failed:', describeError(err));
      });

    this.startedAtSec = Math.floor((this.deps.now?.() ?? Date.now()) / 1000);
    this.poller = new TelegramPoller({
      client: this.client,
      onUpdate: (u) => this.handleUpdate(u),
      onError: (err) => this.setStatus({ state: 'error', detail: describeError(err) }),
      onAuthError: () => this.setStatus({ state: 'auth-error' }),
    });
    this.poller.start();
    this.deps.onActive?.();
    this.setStatus(username !== undefined ? { state: 'connected', botUsername: username } : { state: 'connected' });

    // Greet the chat so the user knows the bot came online. Only here (the
    // explicit start/restart path), never on transient poll-error reconnects in
    // handleUpdate, so a flaky network doesn't spam the chat. Best-effort: a
    // failed greeting must not abort startup.
    void this.push(CONNECTED_NOTICE).catch(() => { /* greeting is best-effort */ });
  }

  stop(): void {
    this.poller?.stop();
    this.poller = null;
    this.client = null;
    this.deps.onInactive?.();
    this.setStatus({ state: 'disabled' });
  }

  /**
   * Forward an OS-wake nudge to the poller so it reconnects its (now-dead)
   * long-poll socket at once instead of waiting out the request timeout. Wired
   * to `powerMonitor`'s `resume` event. No-op when the bot is not running.
   */
  wake(): void {
    this.poller?.wake();
  }

  /**
   * Push an unsolicited message to the authorised chat — used by the
   * desktop → chat run mirror (E-DSK-14 Fase C). No-op when not connected, so
   * a mirror push while the bot is disabled simply does nothing.
   */
  async push(text: string): Promise<void> {
    if (this.client && this.allowedChatId) {
      await this.client.sendMessage(this.allowedChatId, text);
    }
  }

  /** Desktop-mirror counterpart of `replyFile`. Unlike `push`, a disconnected
   *  bot REJECTS (`not-connected`) so the audit records the file as failed,
   *  never as delivered. */
  pushFile(file: OutboundFile): Promise<void> {
    return this.sendFiles([file]);
  }

  /** Desktop-mirror counterpart of `replyFiles`; rejects when disconnected. */
  pushFiles(files: readonly OutboundFile[]): Promise<void> {
    return this.sendFiles(files);
  }

  // ── internals ────────────────────────────────────────────────────────────

  /** Upload to the authorised chat. Unlike `push`, a disconnected bot rejects:
   *  a file the user asked for must surface as failed, not vanish. */
  private async sendFiles(files: readonly OutboundFile[]): Promise<void> {
    const client = this.client;
    if (!client || !this.allowedChatId) throw new OutboundUploadError('not-connected');
    const chatId = this.allowedChatId;
    // Read one at a time: an album is up to 10 × 50 MB, so never hold more
    // than what is actually about to be sent, and never read in parallel.
    const failures = new Map<string, unknown>();
    const ready: { file: OutboundFile; upload: TelegramUploadFile }[] = [];
    for (const file of files) {
      try {
        ready.push({ file, upload: await this.readUpload(file) });
      } catch (err) {
        failures.set(file.path, err);
      }
    }
    if (ready.length === 0) {
      // Nothing readable: a single file rejects with its own error.
      const [only] = files;
      if (files.length === 1 && only) throw failures.get(only.path);
      throw new PartialUploadError(failures);
    }

    const [first] = ready;
    if (ready.length === 1 && first) {
      try {
        await this.sendOne(client, chatId, first.file, first.upload);
      } catch (err) {
        if (failures.size === 0) throw err;
        failures.set(first.file.path, err);
      }
    } else {
      // The caller groups homogeneous kinds; the client re-checks at runtime.
      const items = ready.map(({ file, upload }) => ({
        file: upload,
        as: file.kind,
        ...(file.caption?.trim() && { caption: file.caption }),
      })) as unknown as MediaGroupItems;
      try {
        await client.sendMediaGroup(chatId, items);
      } catch (err) {
        // A 400 is about the album's content (a photo Telegram won't take, a
        // bad dimension…): retry item by item, where `sendFile` can still fall
        // back photo→document. Anything else (429, 401, 413, network) would
        // just fail again N times: the whole batch fails.
        if (!(err instanceof TelegramApiError) || err.statusCode !== 400) {
          if (failures.size === 0) throw err;
          for (const r of ready) failures.set(r.file.path, err);
        } else {
          for (const r of ready) {
            try {
              await this.sendOne(client, chatId, r.file, r.upload);
            } catch (itemErr) {
              failures.set(r.file.path, itemErr);
            }
          }
        }
      }
    }
    if (failures.size > 0) throw new PartialUploadError(failures);
  }

  private async sendOne(
    client: TelegramClient,
    chatId: number,
    file: OutboundFile,
    upload: TelegramUploadFile,
  ): Promise<void> {
    const caption = file.caption?.trim();
    await client.sendFile(chatId, upload, { ...(caption && { caption }), as: file.kind });
  }

  private async readUpload(file: OutboundFile): Promise<TelegramUploadFile> {
    const data = await readOutboundFile(file, this.deps.openFile ?? openNoFollow);
    return { name: file.name, mime: file.mime, data };
  }

  private makeClient(token: string): TelegramClient {
    return this.deps.createClient ? this.deps.createClient(token) : new TelegramClient({ token });
  }

  private setStatus(status: RemoteControlStatus): void {
    this.status = status;
    this.deps.emitStatus(status);
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    const msg = update.message;
    if (!msg) return;
    // Allowlist of one + ignore the pre-connection backlog.
    if (msg.chat.id !== this.allowedChatId) return;
    if (msg.date < this.startedAtSec) return;

    const media = extractMedia(msg);
    if (!media && typeof msg.text !== 'string') return; // nothing actionable

    // A poll that produced a message means we are connected again.
    this.markConnected();

    if (media) {
      const caption = msg.caption?.trim() ?? '';
      if (msg.media_group_id) {
        this.bufferGroup(msg.media_group_id, media, caption, msg);
      } else {
        await this.dispatchAttachments([media], caption, msg.chat.id, msg.message_id, msg.date);
      }
      return;
    }

    const incoming: IncomingMessage = {
      chatId: msg.chat.id,
      text: msg.text ?? '',
      messageId: msg.message_id,
      date: msg.date,
      reply: (text) => this.replyTo(msg.chat.id, text),
      replyFile: (file) => this.sendFiles([file]),
      replyFiles: (files) => this.sendFiles(files),
    };
    await (this.deps.onMessage ?? defaultHandler)(incoming);
  }

  private markConnected(): void {
    if (this.status.state === 'connected') return;
    this.setStatus(
      this.status.botUsername !== undefined
        ? { state: 'connected', botUsername: this.status.botUsername }
        : { state: 'connected' },
    );
  }

  private replyTo(chatId: number, text: string): Promise<void> {
    return this.client ? this.client.sendMessage(chatId, text) : Promise.resolve();
  }

  /** Buffer one album item, (re)arming the debounce that flushes the group. */
  private bufferGroup(groupId: string, media: PendingMedia, caption: string, msg: TelegramMessage): void {
    let buf = this.groupBuffers.get(groupId);
    if (!buf) {
      buf = { items: [], caption: '', chatId: msg.chat.id, messageId: msg.message_id, date: msg.date };
      this.groupBuffers.set(groupId, buf);
    }
    buf.items.push(media);
    if (caption) buf.caption = caption;
    if (buf.timer) clearTimeout(buf.timer);
    const g = buf;
    buf.timer = setTimeout(() => {
      this.groupBuffers.delete(groupId);
      void this.dispatchAttachments(g.items, g.caption, g.chatId, g.messageId, g.date);
    }, this.deps.mediaGroupMs ?? DEFAULT_MEDIA_GROUP_MS);
    buf.timer.unref?.();
  }

  /** Download a batch of media and hand it to the command handler as one run.
   *  A caption is required (it is the instruction); otherwise we ask for one. */
  private async dispatchAttachments(
    items: PendingMedia[],
    caption: string,
    chatId: number,
    messageId: number,
    date: number,
  ): Promise<void> {
    const client = this.client;
    if (!client) return;
    if (!caption) {
      await client.sendMessage(
        chatId,
        `📎 Recibí ${items.length} archivo(s) sin instrucción. Reenvíalos con un texto que describa qué quieres que haga.`,
      );
      return;
    }
    const attachments: RemoteAttachment[] = [];
    const failures: string[] = [];
    for (const item of items) {
      try {
        const info = await client.getFile(item.fileId);
        if (!info.file_path) throw new Error('sin file_path');
        const buffer = await client.downloadFile(info.file_path);
        attachments.push({ name: filenameFor(item, info.file_path), mime: item.mime ?? '', kind: item.kind, buffer });
      } catch {
        failures.push(attachmentLabel(item.kind, item.mime));
      }
    }
    if (failures.length > 0) {
      await client.sendMessage(chatId, `⚠️ No se pudieron descargar: ${failures.join(', ')}`);
    }
    if (attachments.length === 0) return;
    const incoming: IncomingMessage = {
      chatId, text: caption, messageId, date, attachments,
      reply: (text) => this.replyTo(chatId, text),
      replyFile: (file) => this.sendFiles([file]),
      replyFiles: (files) => this.sendFiles(files),
    };
    await (this.deps.onMessage ?? defaultHandler)(incoming);
  }
}

/** Extract the first downloadable media from a message (photos use the
 *  largest rendition). Returns null for a text-only message. */
function extractMedia(msg: TelegramMessage): PendingMedia | null {
  if (msg.photo && msg.photo.length > 0) {
    const largest = msg.photo[msg.photo.length - 1];
    if (largest) return { fileId: largest.file_id, kind: 'photo' };
  }
  if (msg.document) {
    return {
      fileId: msg.document.file_id,
      kind: 'document',
      ...(msg.document.file_name !== undefined && { filename: msg.document.file_name }),
      ...(msg.document.mime_type !== undefined && { mime: msg.document.mime_type }),
    };
  }
  if (msg.video) return { fileId: msg.video.file_id, kind: 'video', ...(msg.video.mime_type !== undefined && { mime: msg.video.mime_type }) };
  if (msg.audio) return { fileId: msg.audio.file_id, kind: 'audio', ...(msg.audio.mime_type !== undefined && { mime: msg.audio.mime_type }) };
  if (msg.voice) return { fileId: msg.voice.file_id, kind: 'voice', ...(msg.voice.mime_type !== undefined && { mime: msg.voice.mime_type }) };
  return null;
}

const MIME_EXT: Record<string, string> = {
  'application/pdf': '.pdf',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

function fallbackExt(kind: RemoteMediaKind): string {
  switch (kind) {
    case 'photo': return '.jpg';
    case 'video': return '.mp4';
    case 'audio':
    case 'voice': return '.ogg';
    default:      return '.bin';
  }
}

/** A filename (with extension) for the saved attachment, used by the enricher. */
function filenameFor(item: PendingMedia, telegramPath: string): string {
  if (item.filename) return item.filename;
  const fromPath = telegramPath.includes('.') ? telegramPath.slice(telegramPath.lastIndexOf('.')) : '';
  const ext = fromPath || (item.mime ? MIME_EXT[item.mime] ?? '' : '') || fallbackExt(item.kind);
  return `tg_${item.kind}${ext}`;
}

/** Strip anything that could leak a token or a path; map known causes to
 *  stable keys. Filesystem errors come from reading an outbound file. */
export function describeError(err: unknown): string {
  if (err instanceof TelegramApiError) {
    if (err.authError) return 'auth-error';
    return err.statusCode ? `http-${err.statusCode}` : 'api-error';
  }
  if (err instanceof OutboundUploadError) return err.reason;
  const code = (err as { code?: unknown } | null)?.code;
  if (code === 'ENOENT') return 'not-found';
  // O_NOFOLLOW on a symlink: ELOOP on Linux/macOS, EMLINK on FreeBSD.
  if (code === 'ELOOP' || code === 'EMLINK') return 'symlink';
  if (code === 'EACCES' || code === 'EPERM') return 'no-access';
  if (code === 'EISDIR') return 'read-error';
  return 'network-error';
}

/** Placeholder handler used until Fase C wires the real command router. */
const defaultHandler: RemoteMessageHandler = async (msg) => {
  await msg.reply('Devia conectado. El control remoto está activo.');
};
