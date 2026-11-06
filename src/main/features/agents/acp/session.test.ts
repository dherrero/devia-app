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

describe('openAcpSession — tools and permissions', () => {
  const permissionTurn = (extra: FakeAcpScript['turns'][number]['steps'] = [], kind = 'edit', title = 'Write file'): FakeAcpScript => ({
    turns: [{ steps: [{ type: 'permission', toolId: 't1', title, kind }, ...extra] }],
  });
  const outcomes = (child: FakeChild): unknown[] => child.record.permissionAnswers;
  const SELECTED_ALLOW = { outcome: { outcome: 'selected', optionId: 'allow' } };
  const SELECTED_REJECT = { outcome: { outcome: 'selected', optionId: 'reject' } };
  const CANCELLED = { outcome: { outcome: 'cancelled' } };

  it('emits tool_use and tool_result for a tool turn', async () => {
    const { child } = start({ turns: [{ steps: [{ type: 'tool', id: 't1', title: 'Read file', kind: 'read', output: 'ok' }] }] });
    await waitFor(() => finished(child));
    expect(child.events).toContainEqual({ type: 'tool_use', id: 't1', name: 'Read file', input: { title: 'Read file' } });
    expect(child.events).toContainEqual({ type: 'tool_result', toolUseId: 't1', content: 'ok', isError: false });
  });

  it('names an MCP tool mcp__<server>__<tool>', async () => {
    const { child } = start(
      { turns: [{ steps: [{ type: 'tool', id: 't1', title: 'devia-kanban_kanban_list', kind: 'other' }] }] },
      { mcpServers: [mcpServer('devia-kanban')] },
    );
    await waitFor(() => finished(child));
    expect(child.events).toContainEqual(expect.objectContaining({ type: 'tool_use', name: 'mcp__devia-kanban__kanban_list' }));
  });

  it("apply asks: surfaces a card with purpose permission and the agent's options", async () => {
    const { child, session } = start(permissionTurn(), { plan: makePlan({ mode: 'apply' }) });
    await waitFor(() => child.uiRequests.length === 1);
    expect(child.uiRequests[0]).toMatchObject({
      callId: 't1',
      kind: 'select',
      purpose: 'permission',
      title: 'Write file',
      options: [
        { id: 'allow', label: 'Allow' },
        { id: 'reject', label: 'Reject' },
      ],
    });
    expect(session.answer('t1', { kind: 'select', value: 'Allow' })).toBe(true);
    await waitFor(() => finished(child));
    expect(outcomes(child)).toEqual([SELECTED_ALLOW]);
  });

  it('answer() with an optionId resolves it too', async () => {
    const { child, session } = start(permissionTurn());
    await waitFor(() => child.uiRequests.length === 1);
    session.answer('t1', { kind: 'text', text: 'reject' });
    await waitFor(() => finished(child));
    expect(outcomes(child)).toEqual([SELECTED_REJECT]);
  });

  it('answer() with cancel or an unmatched answer denies', async () => {
    const a = start(permissionTurn());
    await waitFor(() => a.child.uiRequests.length === 1);
    expect(a.session.answer('t1', { kind: 'cancel' })).toBe(true);
    await waitFor(() => finished(a.child));
    expect(outcomes(a.child)).toEqual([CANCELLED]);

    const b = start(permissionTurn());
    await waitFor(() => b.child.uiRequests.length === 1);
    b.session.answer('t1', { kind: 'text', text: 'sure, go ahead' });
    await waitFor(() => finished(b.child));
    expect(outcomes(b.child)).toEqual([CANCELLED]);
  });

  it('answer() for an unknown call id returns false', async () => {
    const { child, session } = start(permissionTurn());
    await waitFor(() => child.uiRequests.length === 1);
    expect(session.answer('nope', { kind: 'select', value: 'Allow' })).toBe(false);
    session.answer('t1', { kind: 'cancel' });
    await waitFor(() => finished(child));
    expect(session.answer('t1', { kind: 'cancel' })).toBe(false);
  });

  it('apply-yolo on desktop answers allow without a card', async () => {
    const { child } = start(permissionTurn(), { plan: makePlan({ mode: 'apply-yolo' }) });
    await waitFor(() => finished(child));
    expect(child.uiRequests).toEqual([]);
    expect(outcomes(child)).toEqual([SELECTED_ALLOW]);
  });

  it('apply-yolo on a REMOTE run still asks', async () => {
    const { child, session } = start(permissionTurn(), { plan: makePlan({ mode: 'apply-yolo', isRemote: true }) });
    await waitFor(() => child.uiRequests.length === 1);
    expect(outcomes(child)).toEqual([]);
    session.answer('t1', { kind: 'select', value: 'Allow' });
    await waitFor(() => finished(child));
    expect(outcomes(child)).toEqual([SELECTED_ALLOW]);
  });

  it('plan rejects an edit permission without a card and the tool ends failed', async () => {
    const { child } = start(
      permissionTurn([{ type: 'tool', id: 't1', title: 'Write file', kind: 'edit' }]),
      { plan: makePlan({ mode: 'plan' }) },
    );
    await waitFor(() => finished(child));
    expect(child.uiRequests).toEqual([]);
    expect(outcomes(child)).toEqual([SELECTED_REJECT]);
    expect(child.events).toContainEqual({ type: 'tool_result', toolUseId: 't1', content: '', isError: true });
  });

  it('plan allows a Devia MCP tool', async () => {
    const { child } = start(permissionTurn([], 'other', 'mcp__devia-kanban__kanban_list'), {
      plan: makePlan({ mode: 'plan' }),
      mcpServers: [mcpServer('devia-kanban')],
    });
    await waitFor(() => finished(child));
    expect(child.uiRequests).toEqual([]);
    expect(outcomes(child)).toEqual([SELECTED_ALLOW]);
  });

  it.each([
    ['apply', false],
    ['apply-yolo', true],
  ] as const)('when requestUi returns false the permission is denied, never approved (%s, remote=%s)', async (mode, isRemote) => {
    const { child } = start(permissionTurn(), { plan: makePlan({ mode, isRemote }) }, { uiAvailable: false });
    await waitFor(() => finished(child));
    expect(child.uiRequests).toHaveLength(1);
    expect(outcomes(child)).toEqual([SELECTED_REJECT]);
  });

  it('denies with cancelled when no reject option exists and nobody can draw the card', async () => {
    const script: FakeAcpScript = {
      turns: [
        {
          steps: [
            {
              type: 'permission',
              toolId: 't1',
              title: 'Write',
              kind: 'edit',
              options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
            },
          ],
        },
      ],
    };
    const { child } = start(script, {}, { uiAvailable: false });
    await waitFor(() => finished(child));
    expect(outcomes(child)).toEqual([CANCELLED]);
  });

  it('forgets pending permissions when the child closes', async () => {
    const { child, session } = start(permissionTurn());
    await waitFor(() => child.uiRequests.length === 1);
    child.exit(1);
    await waitFor(() => finished(child));
    expect(session.answer('t1', { kind: 'select', value: 'Allow' })).toBe(false);
  });
});

describe('openAcpSession — cancellation, errors and shutdown', () => {
  const HANG: FakeAcpScript = { turns: [{ steps: [{ type: 'text', text: 'partial' }, { type: 'hang' }] }] };
  const errors = (child: FakeChild): AgentEvent[] => child.events.filter((e) => e.type === 'error');
  const settleMs = (ms = 40): Promise<void> => new Promise((r) => setTimeout(r, ms));

  it('abort cancels the session and a hanging turn ends with a cancelled turn_end', async () => {
    const { child, session } = start(HANG);
    await waitFor(() => child.events.some((e) => e.type === 'text_delta'));
    session.abort();
    await waitFor(() => finished(child));
    expect(child.record.cancels).toBe(1);
    expect(child.events.at(-1)).toEqual({ type: 'turn_end', stopReason: 'cancelled' });
    expect(errors(child)).toEqual([]);
  });

  it('abort is idempotent and silent (no error event)', async () => {
    const { child, session } = start(HANG);
    await waitFor(() => child.events.some((e) => e.type === 'text_delta'));
    session.abort();
    session.abort();
    await waitFor(() => finished(child));
    await settleMs();
    expect(child.record.cancels).toBe(1);
    expect(errors(child)).toEqual([]);
    expect(child.events.filter((e) => e.type === 'turn_end')).toHaveLength(1);
  });

  it('abort before the session exists does not throw and emits nothing', async () => {
    const { child, session } = start(HANG);
    expect(() => session.abort()).not.toThrow();
    await settleMs(60);
    expect(errors(child)).toEqual([]);
    expect(child.events.some((e) => e.type === 'turn_end')).toBe(false);
    expect(child.record.prompts).toEqual([]);
  });

  it('an initialize rejection yields one error, kills the child and emits no turn_end', async () => {
    const { child } = start({ ...SIMPLE, failAt: 'initialize' });
    await waitFor(() => finished(child));
    await settleMs();
    expect(errors(child)).toEqual([{ type: 'error', message: expect.stringContaining('scripted failure') }]);
    expect(child.events.some((e) => e.type === 'turn_end')).toBe(false);
    expect(child.kills).toEqual(['SIGTERM']);
  });

  it("a prompt rejection yields one error with the agent's message", async () => {
    const { child } = start({ ...SIMPLE, failAt: 'prompt' });
    await waitFor(() => finished(child));
    await settleMs();
    expect(errors(child)).toEqual([{ type: 'error', message: expect.stringContaining('scripted failure') }]);
    expect(child.events.some((e) => e.type === 'turn_end')).toBe(false);
  });

  it('the child crashing mid-turn yields one "exited before completion" error', async () => {
    const { child } = start({ turns: [{ steps: [{ type: 'text', text: 'x' }, { type: 'crash' }] }] });
    await waitFor(() => finished(child));
    await settleMs();
    expect(errors(child)).toEqual([{ type: 'error', message: 'ACP session exited before completion' }]);
    expect(child.events.some((e) => e.type === 'turn_end')).toBe(false);
  });

  it('stdout closing right after session_started yields the error and no hang', async () => {
    const { child } = start(HANG);
    await waitFor(() => child.events.some((e) => e.type === 'session_started'));
    child.stdout.end();
    await waitFor(() => finished(child));
    await settleMs();
    expect(errors(child)).toHaveLength(1);
    expect(errors(child)[0]).toMatchObject({ message: 'ACP session exited before completion' });
  });

  it('emits nothing after turn_end, not even when the child later exits', async () => {
    const { child } = start(SIMPLE, { killGraceMs: 20 });
    await waitFor(() => finished(child));
    const count = child.events.length;
    await waitFor(() => child.kills.length === 1);
    await settleMs();
    expect(child.events).toHaveLength(count);
    expect(child.events.filter((e) => e.type === 'turn_end')).toHaveLength(1);
  });

  it('a pending permission is cancelled when the turn is aborted', async () => {
    const { child, session } = start({
      turns: [{ steps: [{ type: 'permission', toolId: 't1', title: 'Write', kind: 'edit' }, { type: 'hang' }] }],
    });
    await waitFor(() => child.uiRequests.length === 1);
    session.abort();
    await waitFor(() => finished(child));
    expect(child.record.permissionAnswers).toEqual([{ outcome: { outcome: 'cancelled' } }]);
    expect(session.answer('t1', { kind: 'select', value: 'Allow' })).toBe(false);
  });

  it('flush() after close is a safe no-op', async () => {
    const { child, session } = start(SIMPLE, { killGraceMs: 20 });
    await waitFor(() => child.kills.length === 1);
    expect(() => session.flush()).not.toThrow();
  });
});
