import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { linkSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PartialUploadError,
  TelegramController,
  describeError,
  readOutboundFile,
  type IncomingMessage,
  type OpenOutboundFile,
  type OutboundFile,
  type OutboundFileHandle,
  type OutboundFileStat,
} from './telegram-controller';
import { TelegramApiError, type BotCommand, type TelegramClient, type TelegramUpdate, type TelegramMessage } from '../infrastructure/telegram-client';
import { BOT_COMMANDS } from './commands';
import type { ConfigRepository } from '../../../shared/ports';
import { DEFAULT_CONFIG, type DeviaConfig, type TelegramIntegrationConfig } from '../../../../shared/domain/config';

function fakeConfig(telegram: Partial<TelegramIntegrationConfig>): ConfigRepository {
  const cfg: DeviaConfig = {
    ...DEFAULT_CONFIG,
    remoteControl: { allowShell: false, mirrorDesktop: false, allowFileSend: true, telegram: { enabled: false, botToken: '', chatId: '', ...telegram } },
  };
  return {
    get: () => cfg,
    set: (p) => Object.assign(cfg, p),
    reload: () => cfg,
    hasWorkspace: () => true,
    configPath: () => '/tmp/c.json',
    deviaDir: () => '/tmp/.devia-app',
  } as ConfigRepository;
}

const NOW_MS = 1_700_000_000_000;
const NOW_SEC = Math.floor(NOW_MS / 1000);

function msg(over: Partial<TelegramMessage>): TelegramUpdate {
  return {
    update_id: 1,
    message: { message_id: 1, date: NOW_SEC + 5, chat: { id: 999, type: 'private' }, text: 'hola', ...over },
  };
}

/** Fake client that yields one batch then parks, so the poller dispatches once. */
function fakeClient(opts: {
  username?: string;
  getMeError?: unknown;
  batch?: TelegramUpdate[];
  sent?: Array<{ chatId: number | string; text: string }>;
  setCommands?: Array<{ commands: readonly BotCommand[]; opts?: { scope?: unknown; language_code?: string } | undefined }>;
  setCommandsError?: unknown;
  uploads?: Array<{ op: string; chatId: number | string; names: string[]; opts?: unknown; bytes: number[] }>;
  mediaGroupError?: unknown;
  sendFileError?: (name: string) => unknown;
}): TelegramClient {
  let delivered = false;
  return {
    getMe: async () => {
      if (opts.getMeError) throw opts.getMeError;
      return { id: 1, is_bot: true, first_name: 'B', ...(opts.username !== undefined && { username: opts.username }) };
    },
    getUpdates: async () => {
      if (delivered) return never<TelegramUpdate[]>();
      delivered = true;
      return opts.batch ?? [];
    },
    sendMessage: async (chatId: number | string, text: string) => { opts.sent?.push({ chatId, text }); },
    setMyCommands: async (
      commands: readonly BotCommand[],
      callOpts?: { scope?: unknown; language_code?: string },
    ) => {
      if (opts.setCommandsError) throw opts.setCommandsError;
      opts.setCommands?.push({ commands, opts: callOpts });
      return true as const;
    },
    getFile: async (fileId: string) => ({ file_id: fileId, file_path: `photos/${fileId}.jpg` }),
    downloadFile: async () => new Uint8Array([1, 2, 3]).buffer,
    sendFile: async (chatId: number | string, file: { name: string; data: Uint8Array }, o?: unknown) => {
      const err = opts.sendFileError?.(file.name);
      if (err) throw err;
      opts.uploads?.push({ op: 'sendFile', chatId, names: [file.name], opts: o, bytes: [...file.data] });
    },
    sendMediaGroup: async (
      chatId: number | string,
      items: ReadonlyArray<{ file: { name: string; data: Uint8Array }; as: string; caption?: string }>,
    ) => {
      if (opts.mediaGroupError) throw opts.mediaGroupError;
      opts.uploads?.push({
        op: 'sendMediaGroup', chatId, names: items.map((i) => `${i.as}:${i.file.name}`),
        opts: items.map((i) => i.caption ?? null), bytes: [],
      });
    },
  } as unknown as TelegramClient;
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const never = <T>(): Promise<T> => new Promise<T>(() => { /* never resolves */ });

describe('TelegramController', () => {
  it('stays disabled when Telegram is off', async () => {
    const statuses: string[] = [];
    const c = new TelegramController({
      config: fakeConfig({ enabled: false }),
      emitStatus: (s) => statuses.push(s.state),
    });
    await c.start();
    expect(c.getStatus().state).toBe('disabled');
  });

  it('connects with a valid token and reports the bot username', async () => {
    const c = new TelegramController({
      config: fakeConfig({ enabled: true, botToken: 'tok', chatId: '999' }),
      emitStatus: vi.fn(),
      createClient: () => fakeClient({ username: 'devia_bot' }),
      now: () => NOW_MS,
    });
    await c.start();
    expect(c.getStatus()).toEqual({ state: 'connected', botUsername: 'devia_bot' });
    c.stop();
    expect(c.getStatus().state).toBe('disabled');
  });

  it('signals active on connect and inactive on stop (powerSaveBlocker hook)', async () => {
    const onActive = vi.fn();
    const onInactive = vi.fn();
    const c = new TelegramController({
      config: fakeConfig({ enabled: true, botToken: 'tok', chatId: '999' }),
      emitStatus: vi.fn(),
      createClient: () => fakeClient({ username: 'b' }),
      now: () => NOW_MS,
      onActive,
      onInactive,
    });
    await c.start();
    expect(onActive).toHaveBeenCalledOnce();
    expect(onInactive).not.toHaveBeenCalled();
    c.stop();
    expect(onInactive).toHaveBeenCalledOnce();
  });

  it('does not signal active when startup fails (no blocker leak)', async () => {
    const onActive = vi.fn();
    const c = new TelegramController({
      config: fakeConfig({ enabled: true, botToken: 'bad', chatId: '999' }),
      emitStatus: vi.fn(),
      createClient: () => fakeClient({ getMeError: new TelegramApiError('Unauthorized', { statusCode: 401, authError: true }) }),
      now: () => NOW_MS,
      onActive,
    });
    await c.start();
    expect(onActive).not.toHaveBeenCalled();
  });

  it('wake() is safe to call when the bot is not running', () => {
    const c = new TelegramController({
      config: fakeConfig({ enabled: false }),
      emitStatus: vi.fn(),
    });
    expect(() => c.wake()).not.toThrow();
  });

  it('reports auth-error when getMe is rejected with 401', async () => {
    const c = new TelegramController({
      config: fakeConfig({ enabled: true, botToken: 'bad', chatId: '999' }),
      emitStatus: vi.fn(),
      createClient: () => fakeClient({ getMeError: new TelegramApiError('Unauthorized', { statusCode: 401, authError: true }) }),
      now: () => NOW_MS,
    });
    await c.start();
    expect(c.getStatus().state).toBe('auth-error');
  });

  it('rejects an invalid chat id', async () => {
    const c = new TelegramController({
      config: fakeConfig({ enabled: true, botToken: 'tok', chatId: 'not-a-number' }),
      emitStatus: vi.fn(),
      createClient: () => fakeClient({ username: 'b' }),
    });
    await c.start();
    expect(c.getStatus().state).toBe('error');
  });

  it('dispatches only authorised, fresh messages from the allowed chat', async () => {
    const handled: string[] = [];
    const onMessage = vi.fn((m: IncomingMessage) => { handled.push(m.text); });
    const batch: TelegramUpdate[] = [
      { update_id: 1, message: { message_id: 1, date: NOW_SEC + 5, chat: { id: 999, type: 'private' }, text: 'valid' } },
      { update_id: 2, message: { message_id: 2, date: NOW_SEC + 5, chat: { id: 111, type: 'private' }, text: 'other-chat' } },
      { update_id: 3, message: { message_id: 3, date: NOW_SEC - 100, chat: { id: 999, type: 'private' }, text: 'stale' } },
    ];
    const c = new TelegramController({
      config: fakeConfig({ enabled: true, botToken: 'tok', chatId: '999' }),
      emitStatus: vi.fn(),
      onMessage,
      createClient: () => fakeClient({ username: 'b', batch }),
      now: () => NOW_MS,
    });
    await c.start();
    await flush();
    await flush();
    expect(handled).toEqual(['valid']);
    c.stop();
  });

  it('testToken returns ok + username for a valid token', async () => {
    const c = new TelegramController({
      config: fakeConfig({}),
      emitStatus: vi.fn(),
      createClient: () => fakeClient({ username: 'probe_bot' }),
    });
    expect(await c.testToken('tok')).toEqual({ ok: true, botUsername: 'probe_bot' });
    expect(await c.testToken('  ')).toEqual({ ok: false, error: 'empty-token' });
  });

  it('replies through the live client', async () => {
    const sent: Array<{ chatId: number | string; text: string }> = [];
    const onMessage = vi.fn(async (m: IncomingMessage) => { await m.reply('pong'); });
    const c = new TelegramController({
      config: fakeConfig({ enabled: true, botToken: 'tok', chatId: '999' }),
      emitStatus: vi.fn(),
      onMessage,
      createClient: () => fakeClient({ username: 'b', batch: [msg({})], sent }),
      now: () => NOW_MS,
    });
    await c.start();
    await flush();
    await flush();
    expect(sent.at(-1)).toEqual({ chatId: 999, text: 'pong' });
    c.stop();
  });

  it('downloads a captioned photo and hands it to the handler as an attachment', async () => {
    const received: IncomingMessage[] = [];
    const onMessage = vi.fn((m: IncomingMessage) => { received.push(m); });
    const photo: TelegramUpdate = {
      update_id: 1,
      message: { message_id: 1, date: NOW_SEC + 5, chat: { id: 999, type: 'private' }, caption: 'mira esto', photo: [{ file_id: 'P1' }] },
    };
    const c = new TelegramController({
      config: fakeConfig({ enabled: true, botToken: 'tok', chatId: '999' }),
      emitStatus: vi.fn(),
      onMessage,
      createClient: () => fakeClient({ username: 'b', batch: [photo] }),
      now: () => NOW_MS,
    });
    await c.start();
    await flush(); await flush(); await flush();
    expect(received).toHaveLength(1);
    expect(received[0]?.text).toBe('mira esto');
    expect(received[0]?.attachments).toHaveLength(1);
    expect(received[0]?.attachments?.[0]?.kind).toBe('photo');
    c.stop();
  });

  it('asks for a caption when a photo arrives without one', async () => {
    const sent: Array<{ chatId: number | string; text: string }> = [];
    const onMessage = vi.fn();
    const photo: TelegramUpdate = {
      update_id: 1,
      message: { message_id: 1, date: NOW_SEC + 5, chat: { id: 999, type: 'private' }, photo: [{ file_id: 'P1' }] },
    };
    const c = new TelegramController({
      config: fakeConfig({ enabled: true, botToken: 'tok', chatId: '999' }),
      emitStatus: vi.fn(),
      onMessage,
      createClient: () => fakeClient({ username: 'b', batch: [photo], sent }),
      now: () => NOW_MS,
    });
    await c.start();
    await flush(); await flush();
    expect(onMessage).not.toHaveBeenCalled();
    expect(sent.some((s) => s.text.includes('sin instrucción'))).toBe(true);
    c.stop();
  });

  it('groups an album into a single run after the debounce', async () => {
    const received: IncomingMessage[] = [];
    const onMessage = vi.fn((m: IncomingMessage) => { received.push(m); });
    const batch: TelegramUpdate[] = [
      { update_id: 1, message: { message_id: 1, date: NOW_SEC + 5, chat: { id: 999, type: 'private' }, media_group_id: 'g1', caption: 'analiza estas', photo: [{ file_id: 'P1' }] } },
      { update_id: 2, message: { message_id: 2, date: NOW_SEC + 5, chat: { id: 999, type: 'private' }, media_group_id: 'g1', photo: [{ file_id: 'P2' }] } },
    ];
    const c = new TelegramController({
      config: fakeConfig({ enabled: true, botToken: 'tok', chatId: '999' }),
      emitStatus: vi.fn(),
      onMessage,
      createClient: () => fakeClient({ username: 'b', batch }),
      now: () => NOW_MS,
      mediaGroupMs: 10,
    });
    await c.start();
    await new Promise((r) => setTimeout(r, 50));
    expect(received).toHaveLength(1);
    expect(received[0]?.attachments).toHaveLength(2);
    expect(received[0]?.text).toBe('analiza estas');
    c.stop();
  });

  it('registers the canonical command list at chat scope on connect', async () => {
    const setCommands: Array<{ commands: readonly BotCommand[]; opts?: { scope?: unknown; language_code?: string } | undefined }> = [];
    const c = new TelegramController({
      config: fakeConfig({ enabled: true, botToken: 'tok', chatId: '999' }),
      emitStatus: vi.fn(),
      createClient: () => fakeClient({ username: 'b', setCommands }),
      now: () => NOW_MS,
    });
    await c.start();
    await flush();
    expect(setCommands).toHaveLength(1);
    expect(setCommands[0]?.commands).toEqual(BOT_COMMANDS);
    // Chat scope is the whole point of the registration: anything left at a
    // narrower scope by a previous bot owner (e.g. the old agent-controler)
    // would otherwise override our default-scope writes.
    expect(setCommands[0]?.opts?.scope).toEqual({ type: 'chat', chat_id: 999 });
    c.stop();
  });

  it('survives a failing setMyCommands call (best-effort)', async () => {
    const c = new TelegramController({
      config: fakeConfig({ enabled: true, botToken: 'tok', chatId: '999' }),
      emitStatus: vi.fn(),
      createClient: () =>
        fakeClient({ username: 'b', setCommandsError: new TelegramApiError('boom', { statusCode: 500 }) }),
      now: () => NOW_MS,
    });
    await c.start();
    await flush();
    expect(c.getStatus().state).toBe('connected');
    c.stop();
  });

  it('greets the chat once on connect', async () => {
    const sent: Array<{ chatId: number | string; text: string }> = [];
    const c = new TelegramController({
      config: fakeConfig({ enabled: true, botToken: 'tok', chatId: '999' }),
      emitStatus: vi.fn(),
      createClient: () => fakeClient({ username: 'b', sent }),
      now: () => NOW_MS,
    });
    await c.start();
    await flush();
    const greetings = sent.filter((s) => s.text.includes('Devia conectado'));
    expect(greetings).toHaveLength(1);
    expect(greetings[0]?.chatId).toBe(999);
    c.stop();
  });
  describe('outbound files (S-32)', () => {
    const outbound = (name: string, kind: OutboundFile['kind'], caption?: string, size = 3): OutboundFile => ({
      path: `/w/${name}`, name, size, mime: 'application/pdf', kind, source: 'tool',
      ...(caption !== undefined && { caption }),
    });

    /** In-memory handle: the bytes are `size` copies of `fill`. */
    const fakeOpen = (st: Partial<OutboundFileStat> & { fill?: number } = {}): OpenOutboundFile =>
      vi.fn(async (path: string) => {
        const size = st.size ?? 3;
        const handle: OutboundFileHandle = {
          stat: async () => ({ isFile: () => true, nlink: 1, size, dev: 1, ino: 1, ...st }),
          read: async (buf, off, len) => { buf.fill(st.fill ?? path.length, off, off + len); return { bytesRead: len }; },
          close: async () => undefined,
        };
        return handle;
      });

    const connected = async (
      client: Parameters<typeof fakeClient>[0],
      openFile: OpenOutboundFile = fakeOpen(),
    ): Promise<TelegramController> => {
      const c = new TelegramController({
        config: fakeConfig({ enabled: true, botToken: 'tok', chatId: '999' }),
        emitStatus: vi.fn(),
        createClient: () => fakeClient({ username: 'b', ...client }),
        openFile,
        now: () => NOW_MS,
      });
      await c.start();
      return c;
    };

    it('pushFile/pushFiles reject with not-connected when disconnected (never a silent success)', async () => {
      const openFile = fakeOpen();
      const c = new TelegramController({ config: fakeConfig({ enabled: false }), emitStatus: vi.fn(), openFile });
      const one = await c.pushFile(outbound('a.pdf', 'document')).catch((e: unknown) => e);
      const many = await c.pushFiles([outbound('a.pdf', 'document'), outbound('b.pdf', 'document')]).catch((e: unknown) => e);
      expect(describeError(one)).toBe('not-connected');
      expect(describeError(many)).toBe('not-connected');
      expect(openFile).not.toHaveBeenCalled();
    });

    it('replyFile reads the file through the handle and uploads it to the authorised chat', async () => {
      const uploads: NonNullable<Parameters<typeof fakeClient>[0]['uploads']> = [];
      const onMessage = vi.fn(async (m: IncomingMessage) => {
        await m.replyFile?.(outbound('informe.pdf', 'document', 'el informe', 2));
      });
      const openFile = fakeOpen({ size: 2, fill: 7 });
      const c = new TelegramController({
        config: fakeConfig({ enabled: true, botToken: 'tok', chatId: '999' }),
        emitStatus: vi.fn(), onMessage,
        createClient: () => fakeClient({ username: 'b', batch: [msg({})], uploads }),
        openFile,
        now: () => NOW_MS,
      });
      await c.start();
      await flush();
      await flush();
      expect(openFile).toHaveBeenCalledWith('/w/informe.pdf');
      expect(uploads).toEqual([
        { op: 'sendFile', chatId: 999, names: ['informe.pdf'], opts: { caption: 'el informe', as: 'document' }, bytes: [7, 7] },
      ]);
      c.stop();
    });

    it('pushFiles sends an album with each caption on its own item', async () => {
      const uploads: NonNullable<Parameters<typeof fakeClient>[0]['uploads']> = [];
      const c = await connected({ uploads });
      await c.pushFiles([outbound('a.png', 'photo', 'uno'), outbound('b.mp4', 'video'), outbound('c.png', 'photo', 'dos')]);
      expect(uploads).toEqual([
        { op: 'sendMediaGroup', chatId: 999, names: ['photo:a.png', 'video:b.mp4', 'photo:c.png'], opts: ['uno', null, 'dos'], bytes: [] },
      ]);
      c.stop();
    });

    it('reads the album files one at a time, never in parallel', async () => {
      let open = 0;
      let peak = 0;
      const openFile: OpenOutboundFile = async () => {
        open++;
        peak = Math.max(peak, open);
        await flush();
        return {
          stat: async () => ({ isFile: () => true, nlink: 1, size: 3, dev: 1, ino: 1 }),
          read: async (_b, _o, len) => ({ bytesRead: len }),
          close: async () => { open--; },
        };
      };
      const c = await connected({}, openFile);
      await c.pushFiles([outbound('a.pdf', 'document'), outbound('b.pdf', 'document'), outbound('c.pdf', 'document')]);
      expect(peak).toBe(1);
      c.stop();
    });

    it('an album rejected with a 400 is retried item by item, reporting per-item failures', async () => {
      const uploads: NonNullable<Parameters<typeof fakeClient>[0]['uploads']> = [];
      const c = await connected({
        uploads,
        mediaGroupError: new TelegramApiError('Bad Request: wrong file', { statusCode: 400 }),
        sendFileError: (name) => (name === 'b.png' ? new TelegramApiError('nope', { statusCode: 400 }) : undefined),
      });
      const err = await c.pushFiles([outbound('a.png', 'photo', 'uno'), outbound('b.png', 'photo'), outbound('c.mp4', 'video')])
        .catch((e: unknown) => e);
      expect(uploads.map((u) => [u.op, u.names[0], u.opts])).toEqual([
        ['sendFile', 'a.png', { caption: 'uno', as: 'photo' }],
        ['sendFile', 'c.mp4', { as: 'video' }],
      ]);
      expect(err).toBeInstanceOf(PartialUploadError);
      const failures = (err as PartialUploadError).failures;
      expect([...failures.keys()]).toEqual(['/w/b.png']);
      expect(describeError(failures.get('/w/b.png'))).toBe('http-400');
      c.stop();
    });

    it.each([
      ['429', new TelegramApiError('flood', { statusCode: 429, retryAfterSeconds: 99 }), 'http-429'],
      ['401', new TelegramApiError('auth', { statusCode: 401, authError: true }), 'auth-error'],
      ['413', new TelegramApiError('big', { statusCode: 413 }), 'http-413'],
    ])('an album rejected with %s fails as a whole, without per-item retries', async (_l, error, reason) => {
      const uploads: NonNullable<Parameters<typeof fakeClient>[0]['uploads']> = [];
      const c = await connected({ uploads, mediaGroupError: error });
      const err = await c.pushFiles([outbound('a.pdf', 'document'), outbound('b.pdf', 'document')]).catch((e: unknown) => e);
      expect(describeError(err)).toBe(reason);
      expect(uploads).toEqual([]);
      c.stop();
    });

    it('a file that fails its upload-time check is dropped from the album; the rest still go', async () => {
      const uploads: NonNullable<Parameters<typeof fakeClient>[0]['uploads']> = [];
      const good = fakeOpen();
      const openFile: OpenOutboundFile = async (p) =>
        p === '/w/b.pdf' ? (fakeOpen({ nlink: 2 }))(p) : good(p);
      const c = await connected({ uploads }, openFile);
      const err = await c.pushFiles([outbound('a.pdf', 'document'), outbound('b.pdf', 'document'), outbound('c.pdf', 'document')])
        .catch((e: unknown) => e);
      expect(uploads.map((u) => u.names)).toEqual([['document:a.pdf', 'document:c.pdf']]);
      expect(err).toBeInstanceOf(PartialUploadError);
      expect(describeError((err as PartialUploadError).failures.get('/w/b.pdf'))).toBe('hardlink');
      c.stop();
    });

    it('a missing file rejects with a stable reason', async () => {
      const c = await connected({}, async () => { throw Object.assign(new Error('ENOENT: /w/x'), { code: 'ENOENT' }); });
      const err = await c.pushFile(outbound('x.pdf', 'document')).catch((e: unknown) => e);
      expect(describeError(err)).toBe('not-found');
      c.stop();
    });
  });

  describe('readOutboundFile — upload-time checks on the open handle (S-32)', () => {
    let dir: string;
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'devia-upload-')); });
    afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

    /** Write a file and capture the identity the gate would have validated. */
    const validated = (name: string, bytes: string): OutboundFile => {
      const path = join(dir, name);
      writeFileSync(path, bytes);
      const st = statSync(path);
      return { path, name, size: st.size, mime: 'text/plain', kind: 'document', source: 'tool', identity: { dev: st.dev, ino: st.ino } };
    };
    const reasonOf = (p: Promise<unknown>): Promise<string> => p.then(() => 'ok', (e: unknown) => describeError(e));

    it('reads exactly the validated bytes', async () => {
      const f = validated('a.txt', 'hola');
      expect(Buffer.from(await readOutboundFile(f)).toString()).toBe('hola');
    });

    it('refuses a file swapped for a symlink after validation', async () => {
      const f = validated('a.txt', 'hola');
      writeFileSync(join(dir, 'secret.txt'), 'hola');
      rmSync(f.path);
      symlinkSync(join(dir, 'secret.txt'), f.path);
      expect(await reasonOf(readOutboundFile(f))).toBe('symlink');
    });

    it('refuses a file whose size changed since validation', async () => {
      const f = validated('a.txt', 'hola');
      writeFileSync(f.path, 'hola, y algo más');
      expect(await reasonOf(readOutboundFile(f))).toBe('changed');
    });

    it('refuses a file with more than one hard link', async () => {
      const f = validated('a.txt', 'hola');
      linkSync(f.path, join(dir, 'b.txt'));
      expect(await reasonOf(readOutboundFile(f))).toBe('hardlink');
    });

    it('refuses a different inode than the one validated (same path, same size)', async () => {
      const f = validated('a.txt', 'hola');
      const st = statSync(f.path);
      const other = { ...f, identity: { dev: st.dev, ino: st.ino + 1 } };
      expect(await reasonOf(readOutboundFile(other))).toBe('changed');
    });

    it('refuses a directory', async () => {
      mkdirSync(join(dir, 'd'));
      const st = statSync(join(dir, 'd'));
      const f: OutboundFile = { path: join(dir, 'd'), name: 'd', size: st.size, mime: '', kind: 'document', source: 'tool' };
      expect(await reasonOf(readOutboundFile(f))).toMatch(/not-a-file|read-error/);
    });

    it('closes the handle even when a check fails', async () => {
      const close = vi.fn(async () => undefined);
      const open: OpenOutboundFile = async () => ({
        stat: async () => ({ isFile: () => true, nlink: 1, size: 9, dev: 1, ino: 1 }),
        read: async () => ({ bytesRead: 0 }),
        close,
      });
      const f: OutboundFile = { path: '/x', name: 'x', size: 3, mime: '', kind: 'document', source: 'tool' };
      expect(await reasonOf(readOutboundFile(f, open))).toBe('changed');
      expect(close).toHaveBeenCalledTimes(1);
    });

    it('refuses a file truncated while being read', async () => {
      const open: OpenOutboundFile = async () => ({
        stat: async () => ({ isFile: () => true, nlink: 1, size: 3, dev: 1, ino: 1 }),
        read: async () => ({ bytesRead: 0 }),
        close: async () => undefined,
      });
      const f: OutboundFile = { path: '/x', name: 'x', size: 3, mime: '', kind: 'document', source: 'tool' };
      expect(await reasonOf(readOutboundFile(f, open))).toBe('changed');
    });
  });
});
