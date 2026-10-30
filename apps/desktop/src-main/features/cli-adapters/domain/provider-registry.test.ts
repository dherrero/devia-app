import { describe, it, expect } from 'vitest';
import { ConcreteProviderRegistry } from './provider-registry';
import { EchoProvider } from '../infrastructure/providers/echo-provider';
import type {
  AgentProvider,
  Capabilities,
  ChildProcessLike,
  DetectionResult,
} from '../../../../shared/domain/agent-provider';

function makeChild(): ChildProcessLike {
  return {
    stdout: null,
    stderr: null,
    stdin: null,
    kill: () => false,
    on() { return this; },
  };
}

function makeMinimalProvider(id: string): AgentProvider {
  return {
    id,
    displayName: `Provider ${id}`,
    metadata: {},
    detect: async () => ({ available: false, authStatus: 'unknown' }),
    capabilities: () => ({
      streaming: false,
      thinkingTraces: false,
      interactiveTools: false,
      fileTools: false,
      imageInputs: false,
      resume: false,
      sandboxModel: 'none' as const,
    } satisfies Capabilities),
    prepare: async () => ({ command: 'noop', args: [], env: {}, stdinMode: 'ignore' }),
    attach: () => { throw new Error('not implemented'); },
  };
}

describe('ConcreteProviderRegistry', () => {
  // AC1: registered provider appears in list()
  it('registered provider appears in list() with correct metadata (AC1)', () => {
    const reg = new ConcreteProviderRegistry();
    const echo = new EchoProvider();
    reg.register(echo);

    const list = reg.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe('echo');
    expect(list[0]?.displayName).toBe('Echo (test)');
  });

  it('get() returns registered provider', () => {
    const reg = new ConcreteProviderRegistry();
    reg.register(new EchoProvider());
    expect(reg.get('echo')).toBeDefined();
    expect(reg.get('echo')?.id).toBe('echo');
  });

  it('get() returns undefined for unknown id', () => {
    const reg = new ConcreteProviderRegistry();
    expect(reg.get('unknown')).toBeUndefined();
  });

  // AC2: duplicate id throws
  it('throws on duplicate id (AC2)', () => {
    const reg = new ConcreteProviderRegistry();
    reg.register(makeMinimalProvider('alpha'));
    expect(() => reg.register(makeMinimalProvider('alpha'))).toThrow('Duplicate provider id: alpha');
  });

  it('allows multiple providers with different ids', () => {
    const reg = new ConcreteProviderRegistry();
    reg.register(makeMinimalProvider('a'));
    reg.register(makeMinimalProvider('b'));
    reg.register(makeMinimalProvider('c'));
    expect(reg.list()).toHaveLength(3);
  });

  it('preserves registration order in list()', () => {
    const reg = new ConcreteProviderRegistry();
    reg.register(makeMinimalProvider('first'));
    reg.register(makeMinimalProvider('second'));
    const ids = reg.list().map((p) => p.id);
    expect(ids).toEqual(['first', 'second']);
  });
});

describe('EchoProvider via ProviderRegistry (contract)', () => {
  it('detect() resolves to available: true without throwing (AC3 — no binary required)', async () => {
    const echo = new EchoProvider();
    const result = await echo.detect({ path: [], platform: 'linux', envVars: {} });
    expect(result.available).toBe(true);
    expect(result.authStatus).toBe('ok');
  });

  it('capabilities() returns interactiveTools: false — submitToolResult absent (AC4)', () => {
    const echo = new EchoProvider();
    const detection: DetectionResult = { available: true, authStatus: 'ok' };
    const caps = echo.capabilities(detection);
    expect(caps.interactiveTools).toBe(false);

    // Confirm attach() session has no submitToolResult
    const session = echo.attach(
      makeChild(),
      { runId: 'r1', prompt: 'hello', cwd: '/tmp' },
    );
    expect(session.submitToolResult).toBeUndefined();
  });

  // AC5: cancel is idempotent
  it('cancel() is idempotent — second call resolves without side effects (AC5)', async () => {
    const echo = new EchoProvider();
    const session = echo.attach(
      makeChild(),
      { runId: 'r2', prompt: 'test', cwd: '/tmp' },
    );
    await expect(session.cancel('user')).resolves.toBeUndefined();
    await expect(session.cancel('user')).resolves.toBeUndefined(); // second call — no-op
  });

  // AC6: oversized prompt throws ProviderPrepareError with PROMPT_TOO_LARGE
  it('prepare() throws ProviderPrepareError PROMPT_TOO_LARGE for huge prompt (AC6)', async () => {
    const echo = new EchoProvider();
    const hugePrompt = 'x'.repeat(1_000_001);
    await expect(
      echo.prepare({ runId: 'r3', prompt: hugePrompt, cwd: '/tmp' }),
    ).rejects.toMatchObject({ code: 'PROMPT_TOO_LARGE', retryable: true });
  });

  it('prepare() resolves for valid prompt', async () => {
    const echo = new EchoProvider();
    const invocation = await echo.prepare({ runId: 'r4', prompt: 'hello world', cwd: '/tmp' });
    expect(invocation.command).toBe('echo');
    expect(invocation.stdinMode).toBe('ignore');
  });

  it('attach() events include stream_start, text_delta words, turn_end, stream_end', async () => {
    const echo = new EchoProvider();
    const session = echo.attach(
      makeChild(),
      { runId: 'r5', prompt: 'hello world', cwd: '/tmp' },
    );

    const events = [];
    for await (const ev of session.events) {
      events.push(ev);
    }

    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain('stream_start');
    expect(kinds).toContain('text_delta');
    expect(kinds).toContain('turn_end');
    expect(kinds).toContain('stream_end');

    const text = events
      .filter((e) => e.kind === 'text_delta')
      .map((e) => (e as { kind: 'text_delta'; text: string }).text)
      .join('');
    expect(text.trim()).toBe('hello world');
  });

  it('cancel() aborts event stream early', async () => {
    const echo = new EchoProvider();
    const session = echo.attach(
      makeChild(),
      { runId: 'r6', prompt: 'one two three four five', cwd: '/tmp' },
    );

    const events = [];
    for await (const ev of session.events) {
      events.push(ev);
      if (ev.kind === 'status') {
        await session.cancel('user');
      }
    }

    const end = events.find((e) => e.kind === 'stream_end') as { kind: 'stream_end'; reason: string } | undefined;
    expect(end?.reason).toBe('aborted');
  });
});
