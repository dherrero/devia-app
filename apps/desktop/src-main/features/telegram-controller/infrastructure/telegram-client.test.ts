import { describe, it, expect } from 'vitest';
import {
  TelegramClient,
  TelegramApiError,
  chunkText,
  MAX_MESSAGE_CHARS,
  MAX_CAPTION_CHARS,
  MAX_PHOTO_BYTES,
  MAX_UPLOAD_BYTES,
  type FetchFn,
  type TelegramUploadFile,
} from './telegram-client';

interface Call {
  url: string;
  body: Record<string, unknown>;
}

function fakeFetch(
  responder: (method: string, body: Record<string, unknown>) => { status?: number; json: unknown },
  log?: Call[],
): FetchFn {
  return async (url, init) => {
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const method = url.split('/').pop() ?? '';
    log?.push({ url, body });
    const { status = 200, json } = responder(method, body);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => json,
      text: async () => JSON.stringify(json),
    };
  };
}

describe('chunkText', () => {
  it('returns a single chunk when under the limit', () => {
    expect(chunkText('hola')).toEqual(['hola']);
  });

  it('returns nothing for empty input', () => {
    expect(chunkText('')).toEqual([]);
  });

  it('splits long text into ≤max chunks preferring line breaks', () => {
    const line = 'x'.repeat(1000);
    const text = Array.from({ length: 6 }, () => line).join('\n');
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
    expect(chunks.join('\n')).toBe(text);
  });
});

describe('TelegramClient', () => {
  it('getMe returns the bot user', async () => {
    const client = new TelegramClient({
      token: 't',
      fetchImpl: fakeFetch(() => ({ json: { ok: true, result: { id: 1, is_bot: true, first_name: 'B', username: 'mybot' } } })),
    });
    const me = await client.getMe();
    expect(me.username).toBe('mybot');
  });

  it('throws an auth error on 401', async () => {
    const client = new TelegramClient({
      token: 'bad',
      fetchImpl: fakeFetch(() => ({ status: 401, json: { ok: false, error_code: 401, description: 'Unauthorized' } })),
    });
    await expect(client.getMe()).rejects.toMatchObject({ authError: true });
  });

  it('retries sendMessage as plain text when markdown is rejected (400)', async () => {
    const log: Call[] = [];
    let first = true;
    const client = new TelegramClient({
      token: 't',
      fetchImpl: fakeFetch((method) => {
        if (method === 'sendMessage' && first) {
          first = false;
          return { status: 400, json: { ok: false, error_code: 400, description: "can't parse entities" } };
        }
        return { json: { ok: true, result: {} } };
      }, log),
    });
    await client.sendMessage(42, 'a *b');
    expect(log).toHaveLength(2);
    expect(log[0]?.body['parse_mode']).toBe('Markdown');
    expect(log[1]?.body['parse_mode']).toBeUndefined();
  });

  it('getUpdates passes the offset and timeout', async () => {
    const log: Call[] = [];
    const client = new TelegramClient({
      token: 't',
      fetchImpl: fakeFetch(() => ({ json: { ok: true, result: [] } }), log),
    });
    await client.getUpdates(7, 30);
    expect(log[0]?.body).toMatchObject({ offset: 7, timeout: 30 });
  });

  it('wraps a non-JSON response in TelegramApiError', async () => {
    const client = new TelegramClient({
      token: 't',
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad'); }, text: async () => '' }),
    });
    await expect(client.getMe()).rejects.toBeInstanceOf(TelegramApiError);
  });

  it('getFile resolves the file_path', async () => {
    const log: Call[] = [];
    const client = new TelegramClient({
      token: 't',
      fetchImpl: fakeFetch((method) => {
        expect(method).toBe('getFile');
        return { json: { ok: true, result: { file_id: 'FID', file_path: 'photos/file_1.jpg' } } };
      }, log),
    });
    const info = await client.getFile('FID');
    expect(info.file_path).toBe('photos/file_1.jpg');
    expect(log[0]?.body['file_id']).toBe('FID');
  });

  it('downloadFile GETs the file endpoint and returns the bytes', async () => {
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    let calledUrl = '';
    let calledMethod = '';
    const client = new TelegramClient({
      token: 'TKN',
      fetchImpl: async (url, init) => {
        calledUrl = url;
        calledMethod = init?.method ?? '';
        return { ok: true, status: 200, json: async () => ({}), text: async () => '', arrayBuffer: async () => bytes };
      },
    });
    const out = await client.downloadFile('photos/file_1.jpg');
    expect(new Uint8Array(out)).toEqual(new Uint8Array([1, 2, 3]));
    expect(calledMethod).toBe('GET');
    expect(calledUrl).toBe('https://api.telegram.org/file/botTKN/photos/file_1.jpg');
  });

  it('downloadFile throws on a non-OK response', async () => {
    const client = new TelegramClient({
      token: 't',
      fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' }),
    });
    await expect(client.downloadFile('x')).rejects.toBeInstanceOf(TelegramApiError);
  });

  it('setMyCommands POSTs the command list to the API', async () => {
    const log: Call[] = [];
    const client = new TelegramClient({
      token: 't',
      fetchImpl: fakeFetch((method) => {
        expect(method).toBe('setMyCommands');
        return { json: { ok: true, result: true } };
      }, log),
    });
    const cmds = [
      { command: 'projects', description: 'Lista los proyectos' },
      { command: 'help', description: 'Muestra esta ayuda' },
    ];
    await client.setMyCommands(cmds);
    expect(log).toHaveLength(1);
    expect(log[0]?.body['commands']).toEqual(cmds);
    expect(log[0]?.body['scope']).toBeUndefined();
  });

  it('setMyCommands forwards the scope when supplied', async () => {
    const log: Call[] = [];
    const client = new TelegramClient({
      token: 't',
      fetchImpl: fakeFetch(() => ({ json: { ok: true, result: true } }), log),
    });
    await client.setMyCommands(
      [{ command: 'help', description: 'h' }],
      { scope: { type: 'chat', chat_id: 12345 } },
    );
    expect(log[0]?.body['scope']).toEqual({ type: 'chat', chat_id: 12345 });
  });
});

interface MultipartCall {
  method: string;
  headers: Record<string, string> | undefined;
  form: FormData;
}

type Reply = { status?: number; json: unknown };

/** Multipart fake: records each request's FormData and answers from a queue
 *  (the last reply repeats once the queue runs dry). */
function multipartFetch(replies: Reply[], log: MultipartCall[]): FetchFn {
  return async (url, init) => {
    if (!(init?.body instanceof FormData)) throw new Error('expected a FormData body');
    log.push({ method: url.split('/').pop() ?? '', headers: init.headers, form: init.body });
    const { status = 200, json } = (replies.length > 1 ? replies.shift() : replies[0]) ?? OK;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => json,
      text: async () => JSON.stringify(json),
    };
  };
}

const OK: Reply = { json: { ok: true, result: { message_id: 1, date: 0, chat: { id: 42, type: 'private' } } } };
const badRequest = (description: string): Reply => ({
  status: 400,
  json: { ok: false, error_code: 400, description },
});

const file = (name = 'a.png', mime = 'image/png', size = 3): TelegramUploadFile => ({
  name,
  mime,
  data: new Uint8Array(size),
});

describe('TelegramClient uploads', () => {
  it.each([
    ['document', 'sendDocument'],
    ['photo', 'sendPhoto'],
    ['video', 'sendVideo'],
    ['audio', 'sendAudio'],
  ] as const)('sendFile as %s uses %s with the file in the matching field', async (as, method) => {
    const log: MultipartCall[] = [];
    const client = new TelegramClient({ token: 't', fetchImpl: multipartFetch([OK], log) });
    await client.sendFile(42, file('x.bin', 'application/octet-stream'), { as });
    expect(log).toHaveLength(1);
    expect(log[0]?.method).toBe(method);
    expect(log[0]?.form.get('chat_id')).toBe('42');
    const blob = log[0]?.form.get(as) as File;
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.name).toBe('x.bin');
    expect(blob.type).toBe('application/octet-stream');
    expect(blob.size).toBe(3);
  });

  it('defaults to sendDocument and sets no Content-Type header', async () => {
    const log: MultipartCall[] = [];
    const client = new TelegramClient({ token: 't', fetchImpl: multipartFetch([OK], log) });
    const msg = await client.sendFile(42, file());
    expect(msg.message_id).toBe(1);
    expect(log[0]?.method).toBe('sendDocument');
    expect(log[0]?.headers?.['Content-Type']).toBeUndefined();
    expect(log[0]?.form.get('caption')).toBeNull();
    expect(log[0]?.form.get('parse_mode')).toBeNull();
  });

  it('truncates the caption and sends it as Markdown', async () => {
    const log: MultipartCall[] = [];
    const client = new TelegramClient({ token: 't', fetchImpl: multipartFetch([OK], log) });
    await client.sendFile(42, file(), { caption: 'c'.repeat(MAX_CAPTION_CHARS + 50) });
    expect(log[0]?.form.get('caption')).toBe('c'.repeat(MAX_CAPTION_CHARS));
    expect(log[0]?.form.get('parse_mode')).toBe('Markdown');
  });

  it('retries the caption as plain text when markdown is rejected (400)', async () => {
    const log: MultipartCall[] = [];
    const client = new TelegramClient({
      token: 't',
      fetchImpl: multipartFetch([badRequest("Bad Request: can't parse entities"), OK], log),
    });
    await client.sendFile(42, file(), { caption: 'a *b', as: 'video' });
    expect(log.map((c) => c.method)).toEqual(['sendVideo', 'sendVideo']);
    expect(log[0]?.form.get('parse_mode')).toBe('Markdown');
    expect(log[1]?.form.get('parse_mode')).toBeNull();
    expect(log[1]?.form.get('caption')).toBe('a *b');
  });

  it('falls back to sendDocument when Telegram rejects the photo', async () => {
    const log: MultipartCall[] = [];
    const client = new TelegramClient({
      token: 't',
      fetchImpl: multipartFetch([badRequest('Bad Request: PHOTO_INVALID_DIMENSIONS'), OK], log),
    });
    await client.sendFile(42, file(), { as: 'photo', caption: 'hi' });
    expect(log.map((c) => c.method)).toEqual(['sendPhoto', 'sendDocument']);
    expect(log[1]?.form.get('document')).toBeInstanceOf(Blob);
    expect(log[1]?.form.get('caption')).toBe('hi');
  });

  it('retries a photo caption as plain before falling back to a document', async () => {
    const log: MultipartCall[] = [];
    const client = new TelegramClient({
      token: 't',
      fetchImpl: multipartFetch(
        [badRequest("Bad Request: can't parse entities"), badRequest('Bad Request: IMAGE_PROCESS_FAILED'), OK],
        log,
      ),
    });
    await client.sendFile(42, file(), { as: 'photo', caption: 'a *b' });
    expect(log.map((c) => c.method)).toEqual(['sendPhoto', 'sendPhoto', 'sendDocument']);
  });

  it('sends a photo over MAX_PHOTO_BYTES straight as a document', async () => {
    const log: MultipartCall[] = [];
    const client = new TelegramClient({ token: 't', fetchImpl: multipartFetch([OK], log) });
    await client.sendFile(42, file('big.png', 'image/png', MAX_PHOTO_BYTES + 1), { as: 'photo' });
    expect(log.map((c) => c.method)).toEqual(['sendDocument']);
  });

  it('refuses a file over MAX_UPLOAD_BYTES without calling Telegram', async () => {
    const log: MultipartCall[] = [];
    const client = new TelegramClient({ token: 't', fetchImpl: multipartFetch([OK], log) });
    await expect(client.sendFile(42, file('huge', 'video/mp4', MAX_UPLOAD_BYTES + 1))).rejects.toMatchObject({
      statusCode: 413,
    });
    expect(log).toHaveLength(0);
  });

  it('retries once after retry_after on 429', async () => {
    const log: MultipartCall[] = [];
    const sleeps: number[] = [];
    const tooMany: Reply = {
      status: 429,
      json: { ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 3 } },
    };
    const client = new TelegramClient({
      token: 't',
      fetchImpl: multipartFetch([tooMany, OK], log),
      sleep: async (ms) => void sleeps.push(ms),
    });
    await client.sendFile(42, file());
    expect(sleeps).toEqual([3000]);
    expect(log).toHaveLength(2);
  });

  it('gives up after the single 429 retry and exposes retryAfterSeconds', async () => {
    const sleeps: number[] = [];
    const tooMany: Reply = {
      status: 429,
      json: { ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 2 } },
    };
    const log: MultipartCall[] = [];
    const client = new TelegramClient({
      token: 't',
      fetchImpl: multipartFetch([tooMany], log),
      sleep: async (ms) => void sleeps.push(ms),
    });
    await expect(client.sendFile(42, file())).rejects.toMatchObject({ statusCode: 429, retryAfterSeconds: 2 });
    expect(log).toHaveLength(2);
    expect(sleeps).toEqual([2000]);
  });

  it('does not wait when retry_after exceeds the 30 s cap', async () => {
    const sleeps: number[] = [];
    const log: MultipartCall[] = [];
    const client = new TelegramClient({
      token: 't',
      fetchImpl: multipartFetch(
        [{ status: 429, json: { ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 120 } } }],
        log,
      ),
      sleep: async (ms) => void sleeps.push(ms),
    });
    await expect(client.sendFile(42, file())).rejects.toMatchObject({ retryAfterSeconds: 120 });
    expect(sleeps).toEqual([]);
    expect(log).toHaveLength(1);
  });

  it('maps a 401 on upload to an auth error without leaking the token', async () => {
    const client = new TelegramClient({
      token: 'SECRET-TOKEN',
      fetchImpl: multipartFetch([{ status: 401, json: { ok: false, error_code: 401, description: 'Unauthorized' } }], []),
    });
    const err = await client.sendFile(42, file()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TelegramApiError);
    expect(err).toMatchObject({ authError: true });
    expect((err as Error).message).not.toContain('SECRET-TOKEN');
  });

  it('sendMediaGroup builds attach:// references with each caption on its own item', async () => {
    const log: MultipartCall[] = [];
    const client = new TelegramClient({
      token: 't',
      fetchImpl: multipartFetch([{ json: { ok: true, result: [] } }], log),
    });
    await client.sendMediaGroup(42, [
      { file: file('a.png'), as: 'photo', caption: 'primera' },
      { file: file('b.mp4', 'video/mp4'), as: 'video' },
      { file: file('c.png'), as: 'photo', caption: 'x'.repeat(MAX_CAPTION_CHARS + 50) },
    ]);
    expect(log[0]?.method).toBe('sendMediaGroup');
    expect(log[0]?.headers?.['Content-Type']).toBeUndefined();
    expect(JSON.parse(log[0]?.form.get('media') as string)).toEqual([
      { type: 'photo', media: 'attach://file0', caption: 'primera', parse_mode: 'Markdown' },
      { type: 'video', media: 'attach://file1' },
      { type: 'photo', media: 'attach://file2', caption: 'x'.repeat(MAX_CAPTION_CHARS), parse_mode: 'Markdown' },
    ]);
    expect((log[0]?.form.get('file0') as File).name).toBe('a.png');
    expect((log[0]?.form.get('file1') as File).name).toBe('b.mp4');
  });

  it('sendMediaGroup retries the caption as plain text on a markup 400', async () => {
    const log: MultipartCall[] = [];
    const client = new TelegramClient({
      token: 't',
      fetchImpl: multipartFetch([badRequest("Bad Request: can't parse entities"), { json: { ok: true, result: [] } }], log),
    });
    await client.sendMediaGroup(42, [
      { file: file('a.pdf', 'application/pdf'), as: 'document', caption: 'a *b' },
      { file: file('b.pdf', 'application/pdf'), as: 'document', caption: 'c _d' },
    ]);
    expect(log).toHaveLength(2);
    expect(JSON.parse(log[1]?.form.get('media') as string)).toEqual([
      { type: 'document', media: 'attach://file0', caption: 'a *b' },
      { type: 'document', media: 'attach://file1', caption: 'c _d' },
    ]);
  });

  it('sendMediaGroup rejects albums outside 2–10 items or mixing documents with photos', async () => {
    const log: MultipartCall[] = [];
    const client = new TelegramClient({ token: 't', fetchImpl: multipartFetch([OK], log) });
    await expect(client.sendMediaGroup(42, [{ file: file(), as: 'photo' }])).rejects.toBeInstanceOf(TelegramApiError);
    const eleven = Array.from({ length: 11 }, () => ({ file: file(), as: 'photo' as const }));
    await expect(client.sendMediaGroup(42, eleven)).rejects.toBeInstanceOf(TelegramApiError);
    const mixed = [
      { file: file(), as: 'photo' },
      { file: file(), as: 'document' },
    ] as unknown as Parameters<TelegramClient['sendMediaGroup']>[1];
    await expect(client.sendMediaGroup(42, mixed)).rejects.toBeInstanceOf(TelegramApiError);
    expect(log).toHaveLength(0);
  });
});
