import { describe, expect, it } from 'vitest';
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type Client,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from '../sdk';
import { startFakeAcpAgent, type FakeAcpScript } from './fake-acp-agent';

interface Harness {
  readonly connection: ClientSideConnection;
  readonly updates: SessionNotification[];
  readonly permissions: RequestPermissionRequest[];
  readonly agent: ReturnType<typeof startFakeAcpAgent>;
}

function connect(
  script: FakeAcpScript,
  answer: RequestPermissionResponse = { outcome: { outcome: 'selected', optionId: 'allow' } },
): Harness {
  const toAgent = new TransformStream<Uint8Array, Uint8Array>();
  const toClient = new TransformStream<Uint8Array, Uint8Array>();
  const agent = startFakeAcpAgent(script, { input: toAgent.readable, output: toClient.writable });
  const updates: SessionNotification[] = [];
  const permissions: RequestPermissionRequest[] = [];
  const client: Client = {
    sessionUpdate: async (n) => {
      updates.push(n);
    },
    requestPermission: async (req) => {
      permissions.push(req);
      return answer;
    },
  };
  const connection = new ClientSideConnection(() => client, ndJsonStream(toAgent.writable, toClient.readable));
  return { connection, updates, permissions, agent };
}

const kinds = (h: Harness): string[] => h.updates.map((u) => u.update.sessionUpdate);

describe('fake ACP agent', () => {
  it('answers initialize with its capabilities', async () => {
    const h = connect({ turns: [], capabilities: { loadSession: false } });
    const res = await h.connection.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    expect(res.agentCapabilities).toEqual({ loadSession: false });
    expect(h.agent.record.initialize).toMatchObject({ protocolVersion: PROTOCOL_VERSION });
  });

  it('creates a session and records the cwd and mcpServers it received', async () => {
    const h = connect({ turns: [], modes: [{ id: 'default' }, { id: 'plan' }] });
    await h.connection.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    const res = await h.connection.newSession({ cwd: '/work', mcpServers: [] });
    expect(res.sessionId).toBeTruthy();
    expect(res.modes?.availableModes.map((m) => m.id)).toEqual(['default', 'plan']);
    expect(h.agent.record.newSession).toMatchObject({ cwd: '/work', mcpServers: [] });
  });

  it('streams text and thought chunks then ends the turn with end_turn', async () => {
    const h = connect({ turns: [{ steps: [{ type: 'thought', text: 'hm' }, { type: 'text', text: 'hello' }] }] });
    const { sessionId } = await h.connection.newSession({ cwd: '/w', mcpServers: [] });
    const res = await h.connection.prompt({ sessionId, prompt: [{ type: 'text', text: 'hi' }] });
    expect(res.stopReason).toBe('end_turn');
    expect(kinds(h)).toEqual(['agent_thought_chunk', 'agent_message_chunk']);
    expect(h.agent.record.prompts).toHaveLength(1);
  });

  it('emits a tool_call and a completed tool_call_update', async () => {
    const h = connect({
      turns: [{ steps: [{ type: 'tool', id: 't1', title: 'Read file', kind: 'read', output: 'contents' }] }],
    });
    const { sessionId } = await h.connection.newSession({ cwd: '/w', mcpServers: [] });
    await h.connection.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] });
    expect(kinds(h)).toEqual(['tool_call', 'tool_call_update']);
    expect(h.updates[1]?.update).toMatchObject({ toolCallId: 't1', status: 'completed' });
  });

  it('asks permission and records the client answer', async () => {
    const h = connect({
      turns: [{ steps: [{ type: 'permission', toolId: 't1', title: 'Write', kind: 'edit' }] }],
    });
    const { sessionId } = await h.connection.newSession({ cwd: '/w', mcpServers: [] });
    await h.connection.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] });
    expect(h.permissions).toHaveLength(1);
    expect(h.permissions[0]?.toolCall.toolCallId).toBe('t1');
    expect(h.agent.record.permissionAnswers).toEqual([{ outcome: { outcome: 'selected', optionId: 'allow' } }]);
  });

  it('replays history on session/load', async () => {
    const h = connect({
      turns: [],
      history: [{ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'old' } }],
    });
    await h.connection.loadSession({ sessionId: 's9', cwd: '/w', mcpServers: [] });
    expect(kinds(h)).toEqual(['user_message_chunk']);
    expect(h.agent.record.loadSession).toMatchObject({ sessionId: 's9' });
  });

  it('ends a hanging turn with cancelled when cancel arrives', async () => {
    const h = connect({ turns: [{ steps: [{ type: 'hang' }] }] });
    const { sessionId } = await h.connection.newSession({ cwd: '/w', mcpServers: [] });
    const pending = h.connection.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] });
    await new Promise((r) => setTimeout(r, 20));
    await h.connection.cancel({ sessionId });
    expect((await pending).stopReason).toBe('cancelled');
    expect(h.agent.record.cancels).toBe(1);
  });

  it('fails initialize with the scripted JSON-RPC error', async () => {
    const h = connect({ turns: [], failAt: 'initialize' });
    await expect(
      h.connection.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} }),
    ).rejects.toMatchObject({ message: expect.stringContaining('scripted') });
  });
});
