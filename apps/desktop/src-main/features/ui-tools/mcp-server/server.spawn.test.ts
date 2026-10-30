import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * Drives the COMPILED entry point over real stdio. The unit tests bypass it
 * (they call the dispatcher directly), so without this nothing would catch a
 * broken `--ui-dir` / `--tools` parse or a stdout framing regression — and the
 * entry point is exactly what the agent spawns in production.
 *
 * Skipped when `dist/main` has not been built, so a plain `npm test` on a clean
 * checkout stays green.
 */
const SERVER = path.resolve(
  __dirname,
  '../../../../dist/main/src-main/features/ui-tools/mcp-server/server.js',
);

interface JsonRpcReply {
  id?: number;
  result?: {
    serverInfo?: { name?: string };
    tools?: Array<{ name: string }>;
    content?: Array<{ text: string }>;
    isError?: boolean;
  };
}

let uiDir: string;

beforeEach(() => {
  uiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devia-ui-spawn-'));
});

afterEach(() => {
  fs.rmSync(uiDir, { recursive: true, force: true });
});

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe.skipIf(!fs.existsSync(SERVER))('devia-ui compiled server over stdio', () => {
  it('initialises, advertises only --tools, and resolves a call from the rendezvous dir', async () => {
    const proc = spawn(process.execPath, [SERVER, '--ui-dir', uiDir, '--tools', 'ask_user,todo'], {
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const replies: JsonRpcReply[] = [];
    let buffer = '';
    proc.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      let idx = buffer.indexOf('\n');
      while (idx >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line) replies.push(JSON.parse(line) as JsonRpcReply);
        idx = buffer.indexOf('\n');
      }
    });
    const send = (msg: object): void => {
      proc.stdin.write(`${JSON.stringify(msg)}\n`);
    };

    try {
      send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18' },
      });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
      send({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'devia_ask_user',
          arguments: {
            questions: [{ question: '¿A o B?', options: [{ label: 'A' }, { label: 'B' }] }],
          },
        },
      });

      // Stand in for the main process: pick the request up and answer it.
      let requests: string[] = [];
      for (let i = 0; i < 50 && requests.length === 0; i++) {
        await wait(40);
        requests = fs.readdirSync(uiDir).filter((f) => f.endsWith('.request.json'));
      }
      expect(requests).toHaveLength(1);

      const callId = requests[0]?.replace('.request.json', '') ?? '';
      fs.writeFileSync(path.join(uiDir, `${callId}.answer.json`), JSON.stringify({ answer: 'B' }));

      for (let i = 0; i < 50 && !replies.some((r) => r.id === 3); i++) await wait(40);

      expect(replies.find((r) => r.id === 1)?.result?.serverInfo?.name).toBe('devia-ui');
      expect(replies.find((r) => r.id === 2)?.result?.tools?.map((t) => t.name)).toEqual([
        'devia_ask_user',
        'devia_todo',
      ]);
      const call = replies.find((r) => r.id === 3);
      expect(call?.result?.content?.[0]?.text).toBe('B');
      expect(call?.result?.isError).toBeUndefined();
    } finally {
      proc.stdin.end();
      proc.kill();
    }
  }, 20_000);

  it('exits with code 2 when --ui-dir is missing', async () => {
    const proc = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'ignore', 'ignore'] });
    const code = await new Promise<number | null>((resolve) => proc.on('exit', resolve));

    expect(code).toBe(2);
  }, 20_000);
});
