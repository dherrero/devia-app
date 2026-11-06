import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../../../shared/domain/agent-event';
import { profileFor } from './profile';
import { openAcpSession, toAcpMcpServer, type AcpSessionOptions } from './session';
import type { FakeAcpScript } from './testing/fake-acp-agent';
import { createFakeChild, type FakeChild, type FakeChildOptions } from './testing/fake-child';
import { makePlan, mcpServer } from './testing/fake-plan';

const KIMI = profileFor('kimi');
if (!KIMI) throw new Error('kimi profile missing');

const SIMPLE: FakeAcpScript = {
  turns: [{ steps: [{ type: 'text', text: 'Hola' }, { type: 'usage', inputTokens: 10, outputTokens: 3 }] }],
};

async function waitFor(check: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting for the session');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const finished = (child: FakeChild): boolean =>
  child.events.some((e) => e.type === 'turn_end' || e.type === 'error');

function start(
  script: FakeAcpScript,
  overrides: Partial<AcpSessionOptions> = {},
  childOptions: FakeChildOptions = {},
): { child: FakeChild; session: ReturnType<typeof openAcpSession> } {
  const child = createFakeChild(script, childOptions);
  const session = openAcpSession({
    io: child.io,
    plan: makePlan({ prompt: 'hello' }),
    profile: KIMI as NonNullable<typeof KIMI>,
    systemPrompt: '',
    mcpServers: [],
    ...overrides,
  });
  return { child, session };
}

const types = (events: AgentEvent[]): string[] => events.map((e) => e.type);

describe('openAcpSession — simple turn', () => {
  it('runs initialize, newSession and prompt in order', async () => {
    const { child } = start(SIMPLE);
    await waitFor(() => finished(child));
    expect(child.record.initialize).toBeDefined();
    expect(child.record.newSession).toMatchObject({ cwd: '/work/project' });
    expect(child.record.prompts).toHaveLength(1);
  });

  it("emits session_started with the agent's session id before any text", async () => {
    const { child } = start(SIMPLE);
    await waitFor(() => finished(child));
    expect(child.events[0]).toEqual({ type: 'session_started', agentSessionId: 'fake-session-1' });
    expect(types(child.events).indexOf('text_delta')).toBeGreaterThan(0);
  });

  it('sends the system prompt as a [System]…[User] header before the user text in the first text block', async () => {
    const { child } = start(SIMPLE, { systemPrompt: 'SYS', plan: makePlan({ prompt: 'hello' }) });
    await waitFor(() => finished(child));
    expect(child.record.prompts[0]).toMatchObject({
      prompt: [{ type: 'text', text: '[System]\nSYS\n\n[User]\nhello' }],
    });
  });

  it('sends only the user text when the system prompt is empty', async () => {
    const { child } = start(SIMPLE);
    await waitFor(() => finished(child));
    expect(child.record.prompts[0]).toMatchObject({ prompt: [{ type: 'text', text: 'hello' }] });
  });

  it('streams the text and ends with a completed turn_end', async () => {
    const { child } = start(SIMPLE);
    await waitFor(() => finished(child));
    expect(child.events.filter((e) => e.type === 'text_delta')).toEqual([{ type: 'text_delta', delta: 'Hola' }]);
    expect(child.events.at(-1)).toEqual({ type: 'turn_end', stopReason: 'completed' });
    expect(child.events.filter((e) => e.type === 'turn_end')).toHaveLength(1);
  });

  it('emits usage from the prompt response', async () => {
    const { child } = start(SIMPLE);
    await waitFor(() => finished(child));
    expect(child.events).toContainEqual({ type: 'usage', inputTokens: 10, outputTokens: 3 });
    const usageAt = types(child.events).indexOf('usage');
    expect(usageAt).toBeLessThan(types(child.events).indexOf('turn_end'));
  });

  it("passes the profile's client capabilities to initialize", async () => {
    const { child } = start(SIMPLE);
    await waitFor(() => finished(child));
    expect(child.record.initialize).toMatchObject({
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
  });

  it('passes the cwd and the MCP servers to newSession', async () => {
    const server = mcpServer('devia-ui', { command: 'node', args: ['ui.js', '--x'], env: { TOKEN: 'abc' } });
    const { child } = start(SIMPLE, { mcpServers: [server] });
    await waitFor(() => finished(child));
    expect(child.record.newSession).toMatchObject({
      mcpServers: [{ name: 'devia-ui', command: 'node', args: ['ui.js', '--x'], env: [{ name: 'TOKEN', value: 'abc' }] }],
    });
  });

  it("ends the child's stdin after the turn and kills it after the grace period if it is still alive", async () => {
    const { child } = start(SIMPLE, { killGraceMs: 30 });
    await waitFor(() => finished(child));
    await waitFor(() => child.stdin.writableEnded);
    expect(child.kills).toEqual([]);
    await waitFor(() => child.kills.length === 1);
    expect(child.kills).toEqual(['SIGTERM']);
  });

  it('does not kill a child that exits by itself after stdin ends', async () => {
    const { child } = start(SIMPLE, { killGraceMs: 60 }, { exitOnStdinEnd: true });
    await waitFor(() => finished(child));
    await new Promise((r) => setTimeout(r, 120));
    expect(child.kills).toEqual([]);
  });

  it('emits a single error and no turn_end when newSession fails', async () => {
    const { child } = start({ ...SIMPLE, failAt: 'newSession' });
    await waitFor(() => finished(child));
    await new Promise((r) => setTimeout(r, 30));
    expect(child.events.filter((e) => e.type === 'error')).toHaveLength(1);
    expect(child.events.some((e) => e.type === 'turn_end')).toBe(false);
    expect(child.events.some((e) => e.type === 'session_started')).toBe(false);
    expect(child.kills.length).toBeGreaterThan(0);
  });
});

describe('toAcpMcpServer', () => {
  it('serialises env to name/value pairs and keeps args verbatim', () => {
    expect(
      toAcpMcpServer(mcpServer('a', { command: 'cmd', args: ['1', '2'], env: { K: 'V' } })),
    ).toEqual({ name: 'a', command: 'cmd', args: ['1', '2'], env: [{ name: 'K', value: 'V' }] });
    expect(toAcpMcpServer(mcpServer('b')).env).toEqual([]);
  });
});
