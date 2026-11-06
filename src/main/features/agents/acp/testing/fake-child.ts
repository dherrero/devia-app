import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough, Readable, Writable } from 'node:stream';
import type { AgentEvent } from '../../../../../shared/domain/agent-event';
import type { AgentSessionIo, AgentUiRequest } from '../../domain/agent-mapper';
import { startFakeAcpAgent, type FakeAcpRecord, type FakeAcpScript } from './fake-acp-agent';

export interface FakeChildOptions {
  /** Exit when the client ends stdin (a well-behaved CLI). Default: keep running until killed. */
  readonly exitOnStdinEnd?: boolean;
  /** What `requestUi` answers (default true: a card was drawn). */
  readonly uiAvailable?: boolean;
}

export interface FakeChild {
  readonly io: AgentSessionIo;
  readonly record: FakeAcpRecord;
  readonly events: AgentEvent[];
  readonly uiRequests: AgentUiRequest[];
  readonly kills: string[];
  /** The child's end of the pipes, for tests that want to close them. */
  readonly stdout: PassThrough;
  readonly stdin: PassThrough;
  exit(code?: number): void;
}

export function createFakeChild(script: FakeAcpScript, options: FakeChildOptions = {}): FakeChild {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const emitter = new EventEmitter();
  const kills: string[] = [];
  let exited = false;

  const exit = (code = 0): void => {
    if (exited) return;
    exited = true;
    child.exitCode = code;
    stdout.end();
    emitter.emit('exit', code, null);
    emitter.emit('close', code, null);
  };

  const child = Object.assign(emitter, {
    stdin,
    stdout,
    stderr: new PassThrough(),
    killed: false,
    exitCode: null as number | null,
    kill(signal?: string): boolean {
      kills.push(signal ?? 'SIGTERM');
      child.killed = true;
      exit(143);
      return true;
    },
  });

  const agent = startFakeAcpAgent(script, {
    input: Readable.toWeb(stdin) as ReadableStream<Uint8Array>,
    output: Writable.toWeb(stdout) as WritableStream<Uint8Array>,
  });
  void agent.closed.then(() => exit(1));
  if (options.exitOnStdinEnd) stdin.on('end', () => exit(0));

  const events: AgentEvent[] = [];
  const uiRequests: AgentUiRequest[] = [];
  const io: AgentSessionIo = {
    process: child as unknown as ChildProcess,
    stdin,
    stdout,
    emit: (event) => {
      events.push(event);
    },
    requestUi: (request) => {
      uiRequests.push(request);
      return options.uiAvailable ?? true;
    },
  };
  return { io, record: agent.record, events, uiRequests, kills, stdout, stdin, exit };
}
