/**
 * Thin HTTP wrapper over the Telegram Bot API (E-DSK-14).
 *
 * Deliberately dependency-free: it talks to `https://api.telegram.org` with the
 * global `fetch`, so the embedded controller adds no native modules to the
 * Electron main process and stays trivially mockable in tests (inject
 * `fetchImpl`). Only the endpoints the controller needs are implemented: JSON
 * calls (`getMe`, `sendMessage`, `getUpdates`, …) plus multipart uploads
 * (`sendFile`, `sendMediaGroup`) built on the global `FormData`/`Blob`.
 */
import {
  MAX_CAPTION_CHARS,
  MAX_MEDIA_GROUP,
  MAX_PHOTO_BYTES,
  MAX_UPLOAD_BYTES,
} from '../../../../shared/domain/outbound-file-policy';

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: string;
}

/** One rendition of a photo; Telegram sends several sizes, largest last. */
export interface TelegramPhotoSize {
  file_id: string;
  width?: number;
  height?: number;
  file_size?: number;
}

/** A document / video / audio / voice file reference. */
export interface TelegramFileRef {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramMessage {
  message_id: number;
  /** Unix time (seconds) the message was sent. */
  date: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
  /** Caption that accompanies a media message — used as the instruction. */
  caption?: string;
  /** Set when several media share one album; all carry the same id. */
  media_group_id?: string;
  photo?: TelegramPhotoSize[];
  document?: TelegramFileRef;
  video?: TelegramFileRef;
  audio?: TelegramFileRef;
  voice?: TelegramFileRef;
}

/** Result of `getFile`: the relative path used to download the binary. */
export interface TelegramFileInfo {
  file_id: string;
  file_path?: string;
  file_size?: number;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

/** One entry of the native Telegram menu — registered via `setMyCommands` so
 *  the suggestion list shown when the user taps `/` stays in sync with `/help`.
 *  `command` is the bare name (no leading slash), `description` is plain text. */
export interface BotCommand {
  command: string;
  description: string;
}

/** Scope of a `setMyCommands` registration. Telegram resolves which menu to
 *  show by walking `chat` → `all_private_chats` / `all_group_chats` → `default`,
 *  so a stale list at a more-specific scope OVERRIDES whatever we set at
 *  `default` — including anything BotFather edits. Devia always registers at
 *  `chat` scope so we own the surface for the configured chat. */
export interface BotCommandScope {
  type:
    | 'default'
    | 'all_private_chats'
    | 'all_group_chats'
    | 'all_chat_administrators'
    | 'chat'
    | 'chat_administrators'
    | 'chat_member';
  chat_id?: number | string;
  user_id?: number;
}

/** Telegram caps a single message at 4096 chars; stay under it with margin. */
export const MAX_MESSAGE_CHARS = 4000;

/** Bot API upload limits — defined once in the shared outbound-file policy
 *  (also used by the guard and the gate) and re-exported for this feature. */
export { MAX_UPLOAD_BYTES, MAX_PHOTO_BYTES, MAX_CAPTION_CHARS, MAX_MEDIA_GROUP };

/** Longest `retry_after` we are willing to sleep through before the single
 *  429 retry; above it the error surfaces with `retryAfterSeconds` set. */
const MAX_RETRY_AFTER_SECONDS = 30;

const DEFAULT_API_BASE = 'https://api.telegram.org';

/** Error raised by every failed Telegram call. `authError` is true on 401 so
 *  the controller can stop polling and surface a clear "token rejected".
 *  `retryAfterSeconds` carries Telegram's flood-wait hint on a 429. */
export class TelegramApiError extends Error {
  readonly statusCode: number | undefined;
  readonly authError: boolean;
  readonly retryAfterSeconds: number | undefined;
  constructor(
    message: string,
    opts?: { statusCode?: number; authError?: boolean; retryAfterSeconds?: number },
  ) {
    super(message);
    this.name = 'TelegramApiError';
    this.statusCode = opts?.statusCode;
    this.authError = opts?.authError ?? false;
    this.retryAfterSeconds = opts?.retryAfterSeconds;
  }
}

/** A file to upload. `name` becomes the filename Telegram shows. */
export interface TelegramUploadFile {
  name: string;
  mime: string;
  data: Uint8Array | ArrayBuffer;
}

export type TelegramFileKind = 'document' | 'photo' | 'video' | 'audio';

export interface SendFileOptions {
  caption?: string;
  /** Defaults to `'document'`, which accepts any file type. */
  as?: TelegramFileKind;
}

/** Telegram only groups photos with videos; documents and audio each form
 *  their own homogeneous albums. The union makes a mixed album unrepresentable
 *  for literal arrays; `sendMediaGroup` re-checks it at runtime. */
export type MediaGroupItems =
  | readonly MediaGroupItem<'photo' | 'video'>[]
  | readonly MediaGroupItem<'document'>[]
  | readonly MediaGroupItem<'audio'>[];

/** One album entry. `caption` is shown under that item (Telegram renders each
 *  item's caption on its own, so captions are never merged). */
export interface MediaGroupItem<K extends TelegramFileKind = TelegramFileKind> {
  file: TelegramUploadFile;
  as: K;
  caption?: string;
}

/** Minimal structural shape of `fetch` so we depend on neither the DOM lib nor
 *  a concrete Response type — keeps the client portable and mockable. */
export type FetchFn = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string | FormData;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
  arrayBuffer?(): Promise<ArrayBuffer>;
}>;

export interface TelegramClientOptions {
  token: string;
  fetchImpl?: FetchFn;
  apiBase?: string;
  /** Injectable for tests; defaults to a `setTimeout` promise. */
  sleep?: (ms: number) => Promise<void>;
}

interface TelegramEnvelope<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

type FetchResponse = Awaited<ReturnType<FetchFn>>;

const UPLOAD_METHOD: Record<TelegramFileKind, string> = {
  document: 'sendDocument',
  photo: 'sendPhoto',
  video: 'sendVideo',
  audio: 'sendAudio',
};

function toBlob(file: TelegramUploadFile): Blob {
  return new Blob([file.data], { type: file.mime });
}

function truncateCaption(caption: string): string {
  return caption.length > MAX_CAPTION_CHARS ? caption.slice(0, MAX_CAPTION_CHARS) : caption;
}

function isBadRequest(err: unknown): err is TelegramApiError {
  return err instanceof TelegramApiError && err.statusCode === 400;
}

/** A 400 caused by our Markdown, as opposed to one about the file itself. */
function isEntityParseError(err: TelegramApiError): boolean {
  return /parse entities/i.test(err.message);
}

function assertUploadSize(file: TelegramUploadFile): void {
  if (file.data.byteLength > MAX_UPLOAD_BYTES) {
    throw new TelegramApiError(`"${file.name}" supera el límite de 50 MB de Telegram`, {
      statusCode: 413,
    });
  }
}

/** Split text into chunks no longer than `max`, preferring line boundaries. */
export function chunkText(text: string, max = MAX_MESSAGE_CHARS): string[] {
  if (text.length <= max) return text.length > 0 ? [text] : [];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut <= 0) cut = max;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

export class TelegramClient {
  private readonly token: string;
  private readonly fetchImpl: FetchFn;
  private readonly apiBase: string;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: TelegramClientOptions) {
    this.token = opts.token;
    this.apiBase = opts.apiBase ?? DEFAULT_API_BASE;
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchFn);
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  private async call<T>(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    const url = `${this.apiBase}/bot${this.token}/${method}`;
    // Network-level failures (offline, DNS, aborted) propagate as-is so the
    // poller can distinguish a deliberate stop from a transient error.
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      ...(signal !== undefined && { signal }),
    });
    return this.parseEnvelope<T>(res, method);
  }

  /**
   * POST a multipart form. No Content-Type header: fetch must set it itself so
   * the boundary matches the body. A 429 is retried once after Telegram's
   * `retry_after` (bounded by `MAX_RETRY_AFTER_SECONDS`); `FormData` holds
   * Blobs, not streams, so the same form can be re-sent as-is.
   */
  private async callMultipart<T>(method: string, form: FormData, signal?: AbortSignal): Promise<T> {
    const url = `${this.apiBase}/bot${this.token}/${method}`;
    const send = async (): Promise<T> =>
      this.parseEnvelope<T>(
        await this.fetchImpl(url, {
          method: 'POST',
          body: form,
          ...(signal !== undefined && { signal }),
        }),
        method,
      );
    try {
      return await send();
    } catch (err) {
      const wait = err instanceof TelegramApiError && err.statusCode === 429 ? err.retryAfterSeconds : undefined;
      if (wait === undefined || wait > MAX_RETRY_AFTER_SECONDS) throw err;
      await this.sleep(wait * 1000);
      signal?.throwIfAborted();
      return send();
    }
  }

  private async parseEnvelope<T>(res: FetchResponse, method: string): Promise<T> {
    let body: TelegramEnvelope<T>;
    try {
      body = (await res.json()) as TelegramEnvelope<T>;
    } catch {
      throw new TelegramApiError(`Respuesta no-JSON de Telegram (${method})`, {
        statusCode: res.status,
      });
    }
    if (!res.ok || !body.ok) {
      const code = body.error_code ?? res.status;
      const retryAfter = body.parameters?.retry_after;
      throw new TelegramApiError(body.description ?? `HTTP ${code}`, {
        statusCode: code,
        authError: code === 401,
        ...(retryAfter !== undefined && { retryAfterSeconds: retryAfter }),
      });
    }
    return body.result as T;
  }

  getMe(signal?: AbortSignal): Promise<TelegramUser> {
    return this.call<TelegramUser>('getMe', {}, signal);
  }

  /**
   * Send a text message, transparently split into ≤4000-char chunks. Each chunk
   * is first attempted with Markdown; a 400 (bad markup) retries as plain text
   * so a stray `*`/`_` in agent output never drops the message.
   */
  async sendMessage(chatId: number | string, text: string): Promise<void> {
    for (const chunk of chunkText(text)) {
      try {
        await this.call('sendMessage', { chat_id: chatId, text: chunk, parse_mode: 'Markdown' });
      } catch (err) {
        if (err instanceof TelegramApiError && err.statusCode === 400) {
          await this.call('sendMessage', { chat_id: chatId, text: chunk });
        } else {
          throw err;
        }
      }
    }
  }

  /**
   * Upload one file. `as` picks the Bot API method (`sendDocument` by default).
   * The caption is truncated to `MAX_CAPTION_CHARS` and tried as Markdown
   * first, falling back to plain text on a 400 like `sendMessage`. A photo that
   * Telegram refuses (too large, bad dimensions) or that exceeds
   * `MAX_PHOTO_BYTES` is transparently re-sent as a document.
   */
  async sendFile(
    chatId: number | string,
    file: TelegramUploadFile,
    opts?: SendFileOptions,
    signal?: AbortSignal,
  ): Promise<TelegramMessage> {
    assertUploadSize(file);
    const kind = opts?.as ?? 'document';
    const caption = opts?.caption ? truncateCaption(opts.caption) : undefined;
    if (kind !== 'photo' || file.data.byteLength > MAX_PHOTO_BYTES) {
      const fallbackKind = kind === 'photo' ? 'document' : kind;
      return this.sendSingle(chatId, file, fallbackKind, caption, signal);
    }
    try {
      return await this.sendSingle(chatId, file, 'photo', caption, signal);
    } catch (err) {
      if (!isBadRequest(err)) throw err;
      return this.sendSingle(chatId, file, 'document', caption, signal);
    }
  }

  /**
   * Upload 2–`MAX_MEDIA_GROUP` files as one album. Each blob travels as field
   * `file<i>` referenced from the `media` JSON via `attach://file<i>`. Each
   * item carries its own caption (truncated to `MAX_CAPTION_CHARS`); captions
   * go as Markdown first and the whole album is retried plain on an
   * entity-parse 400. No photo→document fallback here: documents can't join a
   * photo/video album, so a caller that gets another 400 must retry the items
   * one by one through `sendFile`.
   */
  async sendMediaGroup(
    chatId: number | string,
    items: MediaGroupItems,
    signal?: AbortSignal,
  ): Promise<TelegramMessage[]> {
    const list: readonly MediaGroupItem[] = items;
    if (list.length < 2 || list.length > MAX_MEDIA_GROUP) {
      throw new TelegramApiError(`Un álbum necesita entre 2 y ${MAX_MEDIA_GROUP} archivos`);
    }
    const visual = list.filter((i) => i.as === 'photo' || i.as === 'video').length;
    if (visual > 0 ? visual !== list.length : list.some((i) => i.as !== list[0]?.as)) {
      throw new TelegramApiError('Un álbum solo admite fotos y vídeos juntos, o solo documentos, o solo audios');
    }
    for (const { file, as } of list) {
      assertUploadSize(file);
      if (as === 'photo' && file.data.byteLength > MAX_PHOTO_BYTES) {
        throw new TelegramApiError(`"${file.name}" supera el límite de 10 MB para fotos`, { statusCode: 413 });
      }
    }
    const captions = list.map((i) => (i.caption?.trim() ? truncateCaption(i.caption) : undefined));
    const build = (markdown: boolean): FormData => {
      const form = new FormData();
      form.append('chat_id', String(chatId));
      const media = list.map(({ as }, i) => {
        const caption = captions[i];
        return {
          type: as,
          media: `attach://file${i}`,
          ...(caption !== undefined && { caption, ...(markdown && { parse_mode: 'Markdown' }) }),
        };
      });
      form.append('media', JSON.stringify(media));
      list.forEach(({ file }, i) => form.append(`file${i}`, toBlob(file), file.name));
      return form;
    };
    if (captions.every((c) => c === undefined)) return this.callMultipart('sendMediaGroup', build(false), signal);
    try {
      return await this.callMultipart('sendMediaGroup', build(true), signal);
    } catch (err) {
      if (!isBadRequest(err) || !isEntityParseError(err)) throw err;
      return this.callMultipart('sendMediaGroup', build(false), signal);
    }
  }

  /** One upload with the Markdown→plain caption fallback. For photos only an
   *  entity-parse 400 retries plain; any other 400 is about the image itself
   *  and must reach `sendFile` so it can fall back to a document instead of
   *  uploading the same bytes again. */
  private async sendSingle(
    chatId: number | string,
    file: TelegramUploadFile,
    kind: TelegramFileKind,
    caption: string | undefined,
    signal?: AbortSignal,
  ): Promise<TelegramMessage> {
    const build = (markdown: boolean): FormData => {
      const form = new FormData();
      form.append('chat_id', String(chatId));
      form.append(kind, toBlob(file), file.name);
      if (caption !== undefined) {
        form.append('caption', caption);
        if (markdown) form.append('parse_mode', 'Markdown');
      }
      return form;
    };
    const method = UPLOAD_METHOD[kind];
    if (caption === undefined) return this.callMultipart(method, build(false), signal);
    try {
      return await this.callMultipart(method, build(true), signal);
    } catch (err) {
      if (!isBadRequest(err) || (kind === 'photo' && !isEntityParseError(err))) throw err;
      return this.callMultipart(method, build(false), signal);
    }
  }

  getUpdates(offset: number, timeoutSec: number, signal?: AbortSignal): Promise<TelegramUpdate[]> {
    return this.call<TelegramUpdate[]>(
      'getUpdates',
      { offset, timeout: timeoutSec, allowed_updates: ['message'] },
      signal,
    );
  }

  /** Register the bot's command list with Telegram so it shows up in the
   *  native `/` suggestion menu. Re-registering is idempotent.
   *  `opts.scope` controls which menu surface gets the list — almost always
   *  `{ type: 'chat', chat_id: <id> }` so a stale higher-scope list (e.g. from
   *  a previous bot owner) can't override us. */
  setMyCommands(
    commands: readonly BotCommand[],
    opts?: { scope?: BotCommandScope; language_code?: string },
    signal?: AbortSignal,
  ): Promise<true> {
    return this.call<true>('setMyCommands', { commands, ...opts }, signal);
  }

  /** Resolve a `file_id` to a downloadable `file_path` (valid ~1h). */
  getFile(fileId: string, signal?: AbortSignal): Promise<TelegramFileInfo> {
    return this.call<TelegramFileInfo>('getFile', { file_id: fileId }, signal);
  }

  /**
   * Download a file's bytes from the Telegram file endpoint
   * (`/file/bot<token>/<file_path>`) — a plain GET that returns the raw body,
   * not the JSON envelope `call()` handles. Bot API caps downloads at 20 MB.
   */
  async downloadFile(filePath: string, signal?: AbortSignal): Promise<ArrayBuffer> {
    const url = `${this.apiBase}/file/bot${this.token}/${filePath}`;
    const res = await this.fetchImpl(url, { method: 'GET', ...(signal !== undefined && { signal }) });
    if (!res.ok) {
      throw new TelegramApiError(`No se pudo descargar el archivo (HTTP ${res.status})`, {
        statusCode: res.status,
        authError: res.status === 401,
      });
    }
    if (!res.arrayBuffer) {
      throw new TelegramApiError('El cliente fetch no admite descargas binarias');
    }
    return res.arrayBuffer();
  }
}
