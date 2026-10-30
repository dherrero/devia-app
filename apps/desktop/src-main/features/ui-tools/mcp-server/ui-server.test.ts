import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { UI_TOOL_NAMES, type UiToolName } from '../../../../shared/domain/ui-tools';
import {
  answerFilePath,
  readUiRequest,
  requestFilePath,
  writeUiAnswer,
} from '../../../shared/ui-rendezvous';
import {
  DEFAULT_PROTOCOL,
  SERVER_INFO,
  createUiDispatcher,
  type JsonRpcMessage,
} from './ui-server';
import type { UiToolDeps } from './ui-tools-call';

interface Reply {
  id?: number | string | null;
  result?: {
    serverInfo?: { name?: string };
    protocolVersion?: string;
    instructions?: string;
    tools?: Array<{ name: string }>;
    content?: Array<{ text: string }>;
    isError?: boolean;
  };
  error?: { code: number; message: string };
}

let uiDir = '';
let sent: Reply[] = [];
let counter = 0;

function makeDeps(overrides: Partial<UiToolDeps> = {}): UiToolDeps {
  return {
    uiDir,
    timeoutMs: 300,
    pollIntervalMs: 5,
    advertised: [...UI_TOOL_NAMES],
    newCallId: () => `call-${++counter}`,
    ...overrides,
  };
}

function dispatcher(overrides: Partial<UiToolDeps> = {}): (m: JsonRpcMessage) => Promise<void> {
  return createUiDispatcher(makeDeps(overrides), (msg) => {
    sent.push(msg as Reply);
  });
}

beforeEach(() => {
  uiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devia-ui-server-'));
  sent = [];
  counter = 0;
});

afterEach(() => {
  fs.rmSync(uiDir, { recursive: true, force: true });
});

describe('protocol', () => {
  it('echoes the client protocol version and identifies itself', async () => {
    await dispatcher()({ id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
    expect(sent[0]?.result?.protocolVersion).toBe('2024-11-05');
    expect(sent[0]?.result?.serverInfo?.name).toBe(SERVER_INFO.name);
    expect(sent[0]?.result?.instructions).toContain('devia-ui');
  });

  it('falls back to the default protocol version', async () => {
    await dispatcher()({ id: 1, method: 'initialize', params: {} });
    expect(sent[0]?.result?.protocolVersion).toBe(DEFAULT_PROTOCOL);
  });

  it('answers ping and stays silent on notifications', async () => {
    const handle = dispatcher();
    await handle({ id: 2, method: 'ping' });
    await handle({ method: 'notifications/initialized' });
    await handle({ id: null });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.result).toEqual({});
  });

  it('reports an unknown method as -32601', async () => {
    await dispatcher()({ id: 9, method: 'resources/list' });
    expect(sent[0]?.error?.code).toBe(-32601);
  });
});

describe('tools/list', () => {
  it('advertises only the tools this run was given', async () => {
    await dispatcher({ advertised: ['todo', 'ask_user'] })({ id: 1, method: 'tools/list' });
    expect(sent[0]?.result?.tools?.map((t) => t.name)).toEqual(['devia_ask_user', 'devia_todo']);
  });

  it('advertises nothing when the run was given nothing', async () => {
    await dispatcher({ advertised: [] })({ id: 1, method: 'tools/list' });
    expect(sent[0]?.result?.tools).toEqual([]);
  });
});

describe('tools/call', () => {
  it('resolves a blocking tool from the rendezvous answer', async () => {
    const handle = dispatcher();
    const call = handle({
      id: 1,
      method: 'tools/call',
      params: {
        name: 'devia_ask_user',
        arguments: { questions: [{ question: '¿A o B?', options: [{ label: 'A' }] }] },
      },
    });

    await waitFor(() => fs.existsSync(requestFilePath(uiDir, 'call-1')));
    const request = readUiRequest(requestFilePath(uiDir, 'call-1'));
    expect(request?.tool).toBe('ask_user');
    expect(request?.expectsAnswer).toBe(true);

    writeUiAnswer(uiDir, 'call-1', 'A');
    await call;

    expect(sent[0]?.result?.content?.[0]?.text).toBe('A');
    expect(sent[0]?.result?.isError).toBeUndefined();
  });

  it('cleans both rendezvous files up when a blocking call resolves', async () => {
    const handle = dispatcher();
    const call = handle({
      id: 1,
      method: 'tools/call',
      params: { name: 'devia_confirm', arguments: { action: 'rm -rf dist' } },
    });
    await waitFor(() => fs.existsSync(requestFilePath(uiDir, 'call-1')));
    writeUiAnswer(uiDir, 'call-1', 'yes');
    await call;

    expect(fs.existsSync(requestFilePath(uiDir, 'call-1'))).toBe(false);
    expect(fs.existsSync(answerFilePath(uiDir, 'call-1'))).toBe(false);
  });

  it('returns an actionable error when nobody answers in time', async () => {
    await dispatcher({ timeoutMs: 30 })({
      id: 1,
      method: 'tools/call',
      params: { name: 'devia_ask_user', arguments: { questions: [] } },
    });

    expect(sent[0]?.result?.isError).toBe(true);
    expect(sent[0]?.result?.content?.[0]?.text).toContain('Do not call devia_ask_user again');
  });

  it('returns immediately for a fire-and-forget tool and never waits', async () => {
    const started = Date.now();
    await dispatcher({ timeoutMs: 60_000 })({
      id: 1,
      method: 'tools/call',
      params: { name: 'devia_todo', arguments: { items: [{ text: 'uno' }] } },
    });

    expect(Date.now() - started).toBeLessThan(1_000);
    expect(sent[0]?.result?.content?.[0]?.text).toBe('Recorded.');
    expect(readUiRequest(requestFilePath(uiDir, 'call-1'))?.expectsAnswer).toBe(false);
  });

  it('refuses a tool that was not advertised, without crashing', async () => {
    await dispatcher({ advertised: ['todo'] })({
      id: 1,
      method: 'tools/call',
      params: { name: 'devia_confirm', arguments: { action: 'x' } },
    });

    expect(sent[0]?.result?.isError).toBe(true);
    expect(sent[0]?.result?.content?.[0]?.text).toContain('not available in this run');
    expect(fs.readdirSync(uiDir)).toHaveLength(0);
  });

  it('reports an unknown tool name as a tool error, not a transport error', async () => {
    await dispatcher()({ id: 1, method: 'tools/call', params: { name: 'devia_nope' } });
    expect(sent[0]?.error).toBeUndefined();
    expect(sent[0]?.result?.isError).toBe(true);
    expect(sent[0]?.result?.content?.[0]?.text).toContain('Unknown tool');
  });

  it('tolerates missing params and missing arguments', async () => {
    const handle = dispatcher({ timeoutMs: 20 });
    await handle({ id: 1, method: 'tools/call' });
    await handle({ id: 2, method: 'tools/call', params: { name: 'devia_todo' } });
    expect(sent[0]?.result?.isError).toBe(true);
    expect(sent[1]?.result?.content?.[0]?.text).toBe('Recorded.');
  });

  it('lets a local resolver short-circuit the rendezvous', async () => {
    const resolveLocally = async (tool: UiToolName): Promise<{ text: string } | null> =>
      tool === 'skill' ? { text: 'skill A, skill B' } : null;
    await dispatcher({ resolveLocally })({
      id: 1,
      method: 'tools/call',
      params: { name: 'devia_skill', arguments: { op: 'list' } },
    });

    expect(sent[0]?.result?.content?.[0]?.text).toBe('skill A, skill B');
    expect(fs.readdirSync(uiDir)).toHaveLength(0);
  });

  it('serves other messages while a blocking call is pending', async () => {
    const handle = dispatcher({ timeoutMs: 400 });
    const pending = handle({
      id: 1,
      method: 'tools/call',
      params: { name: 'devia_ask_user', arguments: { questions: [] } },
    });
    await handle({ id: 2, method: 'ping' });

    expect(sent.map((r) => r.id)).toEqual([2]);
    writeUiAnswer(uiDir, 'call-1', 'ok');
    await pending;
    expect(sent.map((r) => r.id)).toEqual([2, 1]);
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('waitFor timed out');
}
