/**
 * ChildProcessCliLauncher driven by a real LegacyMapper (S-30 T-347): the
 * mapper prepares argv / stdin / system prompt, the launcher only spawns and
 * relays — these tests check both halves fit, and that the stdin protocols
 * (text, Claude's stream-json, RPC sessions) still behave.
 *
 * Strategy: `node:child_process` is mocked so spawn returns a fully-controlled
 * fake ChildProcess — no real process is ever started.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Writable, Readable } from 'node:stream';

// ── Fake ChildProcess factory ──────────────────────────────────────────────

interface FakeStdin extends Writable {
  writtenChunks: string[];
  endCalled: boolean;
}

interface FakeProc extends EventEmitter {
  stdin: FakeStdin;
  stdout: Readable;
  stderr: Readable;
  kill: ReturnType<typeof vi.fn>;
}

function makeFakeProc(): FakeProc {
  const proc = new EventEmitter() as FakeProc;
  const writtenChunks: string[] = [];
  let endCalled = false;

  const stdin = new Writable({
    write(chunk: Buffer | string, _enc, cb) {
      writtenChunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
      cb();
    },
  }) as FakeStdin;
  stdin.writtenChunks = writtenChunks;
  Object.defineProperty(stdin, 'endCalled', {
    get: () => endCalled,
    set: (v) => { endCalled = v; },
  });

  const origEnd = stdin.end.bind(stdin);
  stdin.end = ((...args: Parameters<typeof stdin.end>) => {
    endCalled = true;
    return origEnd(...args);
  }) as typeof stdin.end;

  proc.stdin = stdin;
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  proc.stdout = new Readable({ read() {} });
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  proc.stderr = new Readable({ read() {} });
  proc.kill = vi.fn();

  return proc;
}

// ── Module mock ──────────────────────────────────────────────────────────

// We create the fake process before the mock factory is called, so the
// captured reference is available in assertions.
let currentFakeProc: FakeProc;

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => {
    currentFakeProc = makeFakeProc();
    return currentFakeProc;
  }),
}));

// Import after the mock is registered.
import { spawn } from 'node:child_process';
import { ChildProcessCliLauncher } from './cli-launcher';
import type { RuntimeAgentDef } from '../domain/runtime-agent-def';
import type { CliProcessHandle, CliRunHandlers } from './cli-launcher';
import { LegacyMapper } from '../../agents/infrastructure/legacy/legacy-mapper';
import { makeRunPlan } from '../../agents/testing/make-run-plan';
import type { AgentRunPlan, DeliveryResolution } from '../../agents/domain';

// ── Minimal agent def helpers ─────────────────────────────────────────────

function makeStreamJsonDef(): RuntimeAgentDef {
  return {
    id: 'claude',
    name: 'Claude',
    bin: 'claude',
    versionArgs: ['--version'],
    fallbackModels: [],
    buildArgs: () => ['--output-format', 'stream-json', '--verbose'],
    streamFormat: 'claude-stream-json',
    systemPromptStrategy: 'unsupported',
    promptViaStdin: true,
    promptInputFormat: 'stream-json',
  };
}

function makeTextDef(): RuntimeAgentDef {
  return {
    id: 'codex',
    name: 'Codex',
    bin: 'codex',
    versionArgs: ['--version'],
    fallbackModels: [],
    buildArgs: () => [],
    streamFormat: 'plain',
    systemPromptStrategy: 'unsupported',
    promptViaStdin: true,
    promptInputFormat: 'text',
  };
}

function noopHandlers(overrides: Partial<CliRunHandlers> = {}): CliRunHandlers {
  return {
    onOutput: () => undefined,
    onDone: () => undefined,
    onError: () => undefined,
    onUiRequest: () => false,
    ...overrides,
  };
}

const NO_DELIVERY: DeliveryResolution = { mcpServerIds: [], skills: 'none', subagents: 'none', notices: [] };

/** Prepare through a real LegacyMapper, then launch — the production path. */
function launch(
  def: RuntimeAgentDef,
  planOverrides: Partial<AgentRunPlan> = {},
  systemPrompt = '',
  handlers: CliRunHandlers = noopHandlers(),
): CliProcessHandle {
  const mapper = new LegacyMapper(def, { nativeMcp: { deliver: () => ({ file: null, deliveredServerIds: [] }) } });
  const plan = makeRunPlan({ agentId: def.id, cwd: '/tmp', ...planOverrides });
  const prepared = mapper.prepareRun(plan, systemPrompt, NO_DELIVERY);
  if (!prepared.ok) throw new Error(prepared.error);
  return new ChildProcessCliLauncher().launch(
    { def, cwd: plan.cwd, prepared: prepared.run, openSession: (io) => mapper.openSession(io, plan), runId: plan.runId },
    handlers,
  );
}

const lastSpawnArgs = (): string[] => {
  const call = vi.mocked(spawn).mock.calls.at(-1);
  if (!call) throw new Error('spawn was not called');
  return call[1] as string[];
};

describe('ChildProcessCliLauncher — stdin protocol', () => {
  beforeEach(() => { vi.useFakeTimers(); });

  it('keeps stdin open after the prompt for a stream-json agent (Claude)', () => {
    launch(makeStreamJsonDef(), { prompt: 'hello' });
    expect(currentFakeProc.stdin.endCalled).toBe(false);
    expect(JSON.parse(currentFakeProc.stdin.writtenChunks[0] ?? '')).toMatchObject({ type: 'user' });
  });

  it('closes stdin right after the prompt for a text agent', () => {
    launch(makeTextDef(), { prompt: 'hello' });
    expect(currentFakeProc.stdin.writtenChunks).toEqual(['hello']);
    expect(currentFakeProc.stdin.endCalled).toBe(true);
  });

  it('answers a stream-json agent with a well-formed tool_result line on stdin', () => {
    const handle = launch(makeStreamJsonDef(), { prompt: 'start' });
    expect(handle.answer('tool-use-id-123', { kind: 'text', text: 'the answer is 42' })).toBe(true);
    const chunk = currentFakeProc.stdin.writtenChunks.at(-1) ?? '';
    expect(chunk.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(chunk.trimEnd()) as {
      type: string;
      parent_tool_use_id?: string;
      isSynthetic?: boolean;
      message: { role: string; content: Array<{ type: string; tool_use_id: string; content: string }> };
    };
    expect(parsed).toMatchObject({ type: 'user', parent_tool_use_id: 'tool-use-id-123', isSynthetic: true });
    expect(parsed.message.content[0]).toEqual({ type: 'tool_result', tool_use_id: 'tool-use-id-123', content: 'the answer is 42' });
  });

  it('does not write once the process has closed', () => {
    const handle = launch(makeStreamJsonDef(), { prompt: 'start' });
    currentFakeProc.emit('close', 0, null);
    const before = [...currentFakeProc.stdin.writtenChunks];
    expect(() => handle.answer('id', { kind: 'text', text: 'answer' })).not.toThrow();
    expect(currentFakeProc.stdin.writtenChunks).toEqual(before);
  });

  it('a text agent has no native answer channel', () => {
    const handle = launch(makeTextDef(), { prompt: 'hello' });
    expect(handle.answer('id', { kind: 'text', text: 'x' })).toBe(false);
  });
});

// ── argv-prepend system prompt (S-21 T-226) ───────────────────────────────

function makeArgvPrependDef(): RuntimeAgentDef {
  return {
    id: 'grok',
    name: 'Grok',
    bin: 'grok',
    versionArgs: ['--version'],
    fallbackModels: [],
    buildArgs: (prompt) => ['-p', prompt, '--format', 'json'],
    streamFormat: 'json-event-stream',
    eventParser: 'grok',
    systemPromptStrategy: 'argv-prepend',
    maxPromptArgBytes: 200_000,
  };
}

describe('ChildProcessCliLauncher — argv-prepend system prompt', () => {
  beforeEach(() => { vi.useFakeTimers(); });

  it('inlines a [System] ... [User] header into the prompt argv', () => {
    launch(makeArgvPrependDef(), { prompt: 'do the thing' }, 'BE SAFE');
    const args = lastSpawnArgs();
    expect(args[args.indexOf('-p') + 1]).toBe('[System]\nBE SAFE\n\n[User]\ndo the thing');
    expect(args).toContain('--format');
    expect(args).toContain('json');
  });

  it('passes the bare prompt when no system prompt is supplied', () => {
    launch(makeArgvPrependDef(), { prompt: 'just this' });
    const args = lastSpawnArgs();
    expect(args[args.indexOf('-p') + 1]).toBe('just this');
  });

  it('refuses to prepare a prompt over the argv budget — nothing is spawned', () => {
    const def = { ...makeArgvPrependDef(), maxPromptArgBytes: 10 };
    const mapper = new LegacyMapper(def, { nativeMcp: { deliver: () => ({ file: null, deliveredServerIds: [] }) } });
    const before = vi.mocked(spawn).mock.calls.length;
    const result = mapper.prepareRun(makeRunPlan({ prompt: 'x'.repeat(100) }), '', NO_DELIVERY);
    expect(result.ok).toBe(false);
    expect(vi.mocked(spawn).mock.calls.length).toBe(before);
  });
});

describe('ChildProcessCliLauncher — argv-file system prompt (pi)', () => {
  function makeArgvFileDef(): RuntimeAgentDef {
    return {
      id: 'pi',
      name: 'Pi',
      bin: 'pi',
      versionArgs: ['--version'],
      fallbackModels: [],
      buildArgs: () => ['--mode', 'rpc'],
      streamFormat: 'pi-rpc',
      systemPromptStrategy: 'argv-file',
      buildSystemPromptFileArgs: (file) => ['--append-system-prompt', file],
    };
  }

  it('writes the system prompt to a file and passes its path; cleanup removes it', async () => {
    const fs = await import('node:fs');
    const def = makeArgvFileDef();
    const mapper = new LegacyMapper(def, { nativeMcp: { deliver: () => ({ file: null, deliveredServerIds: [] }) } });
    const prepared = mapper.prepareRun(makeRunPlan({ agentId: 'pi', runId: 'run-1', prompt: 'hi' }), 'BE SAFE', NO_DELIVERY);
    if (!prepared.ok) throw new Error(prepared.error);
    const args = prepared.run.args;
    const file = args[args.indexOf('--append-system-prompt') + 1] ?? '';
    expect(file).toMatch(/devia-system-prompt-pi-run-1\.md$/);
    expect(fs.readFileSync(file, 'utf8')).toBe('BE SAFE');
    expect(args).not.toContain('hi');
    // The RPC driver owns stdin: nothing for the launcher to write.
    expect(prepared.run.stdin).toEqual({ kind: 'session' });
    prepared.run.cleanup();
    expect(fs.existsSync(file)).toBe(false);
  });

  it('adds no flag when there is no system prompt', () => {
    launch(makeArgvFileDef(), { agentId: 'pi', prompt: 'hi' });
    expect(lastSpawnArgs()).toEqual(['--mode', 'rpc']);
  });
});

describe('ChildProcessCliLauncher — child environment', () => {
  it('points PWD at the run cwd, not at the parent process directory', () => {
    launch(makeTextDef(), { cwd: '/tmp/some-project' });
    const options = vi.mocked(spawn).mock.calls.at(-1)?.[2] as { env: NodeJS.ProcessEnv; cwd: string };
    expect(options.cwd).toBe('/tmp/some-project');
    expect(options.env['PWD']).toBe('/tmp/some-project');
  });
});

describe('ChildProcessCliLauncher — mapper-owned env', () => {
  it('applies agentEnv past the user allowlist, and filters user overrides through it', () => {
    const def = makeTextDef();
    new ChildProcessCliLauncher().launch(
      {
        def,
        cwd: '/tmp',
        prepared: {
          args: [], stdin: { kind: 'none' }, mcpServerIds: [], notices: [], cleanup: () => undefined,
          env: { NOT_ALLOWED: 'x' },
          agentEnv: { OPENCODE_CONFIG: '/tmp/run.json' },
        },
        openSession: () => ({ flush: () => undefined, abort: () => undefined, answer: () => false }),
      },
      noopHandlers(),
    );
    const env = (vi.mocked(spawn).mock.calls.at(-1)?.[2] as { env: NodeJS.ProcessEnv }).env;
    expect(env['OPENCODE_CONFIG']).toBe('/tmp/run.json');
    expect(env['NOT_ALLOWED']).toBeUndefined();
  });
});
