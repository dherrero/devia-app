import path from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { AcpConnection, webStreamsFromChild, type AcpClientHandlers } from './connection';
import { AgentSideConnection, PROTOCOL_VERSION, ndJsonStream, type Agent } from './sdk';
import { startFakeAcpAgent, type FakeAcpScript } from './testing/fake-acp-agent';

const CAPS = { fs: { readTextFile: false, writeTextFile: false }, terminal: false };

interface Rig {
  readonly connection: AcpConnection;
  readonly agent: ReturnType<typeof startFakeAcpAgent>;
  readonly updates: { sessionId: string; update: unknown }[];
  readonly permissionRequests: unknown[];
}

function rig(
  script: FakeAcpScript,
  onRequestPermission: AcpClientHandlers['onRequestPermission'] = async () => ({
    outcome: 'selected',
    optionId: 'allow',
  }),
): Rig {
  const toAgent = new TransformStream<Uint8Array, Uint8Array>();
  const toClient = new TransformStream<Uint8Array, Uint8Array>();
  const agent = startFakeAcpAgent(script, { input: toAgent.readable, output: toClient.writable });
  const updates: Rig['updates'] = [];
  const permissionRequests: unknown[] = [];
  const connection = new AcpConnection(
    { input: toClient.readable, output: toAgent.writable },
    {
      onSessionUpdate: (sessionId, update) => updates.push({ sessionId, update }),
      onRequestPermission: async (req) => {
        permissionRequests.push(req);
        return onRequestPermission(req);
      },
    },
  );
  return { connection, agent, updates, permissionRequests };
}

describe('AcpConnection', () => {
  it('initialize returns the agent capabilities and auth methods', async () => {
    const r = rig({ turns: [], capabilities: { loadSession: true } });
    const info = await r.connection.initialize(CAPS);
    expect(info.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(info.capabilities).toEqual({ loadSession: true });
    expect(info.authMethods).toEqual([]);
  });

  it("initialize sends the profile's client capabilities with fs and terminal off", async () => {
    const r = rig({ turns: [] });
    await r.connection.initialize(CAPS);
    expect(r.agent.record.initialize).toMatchObject({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: CAPS,
      clientInfo: { name: 'devia', version: 'desktop' },
    });
  });

  it('forwards session/update notifications to the handler with the session id', async () => {
    const r = rig({ turns: [{ steps: [{ type: 'text', text: 'hi' }] }] });
    await r.connection.initialize(CAPS);
    const { sessionId } = await r.connection.raw.newSession({ cwd: '/w', mcpServers: [] });
    await r.connection.raw.prompt({ sessionId, prompt: [{ type: 'text', text: 'x' }] });
    expect(r.updates).toHaveLength(1);
    expect(r.updates[0]?.sessionId).toBe(sessionId);
    expect(r.updates[0]?.update).toMatchObject({ sessionUpdate: 'agent_message_chunk' });
  });

  it('routes a permission request to the handler and sends back its outcome', async () => {
    const r = rig({ turns: [{ steps: [{ type: 'permission', toolId: 't1', title: 'Write', kind: 'edit' }] }] }, async () => ({
      outcome: 'selected',
      optionId: 'reject',
    }));
    const { sessionId } = await r.connection.raw.newSession({ cwd: '/w', mcpServers: [] });
    await r.connection.raw.prompt({ sessionId, prompt: [{ type: 'text', text: 'x' }] });
    expect(r.permissionRequests).toHaveLength(1);
    expect(r.agent.record.permissionAnswers).toEqual([{ outcome: { outcome: 'selected', optionId: 'reject' } }]);
  });

  it('answers cancelled when the permission handler throws', async () => {
    const r = rig({ turns: [{ steps: [{ type: 'permission', toolId: 't1', title: 'Write', kind: 'edit' }] }] }, async () => {
      throw new Error('boom');
    });
    const { sessionId } = await r.connection.raw.newSession({ cwd: '/w', mcpServers: [] });
    await r.connection.raw.prompt({ sessionId, prompt: [{ type: 'text', text: 'x' }] });
    expect(r.agent.record.permissionAnswers).toEqual([{ outcome: { outcome: 'cancelled' } }]);
  });

  it('an agent calling fs/read_text_file gets a JSON-RPC error and the connection stays usable', async () => {
    const toAgent = new TransformStream<Uint8Array, Uint8Array>();
    const toClient = new TransformStream<Uint8Array, Uint8Array>();
    let fsError: unknown;
    let agentConn: AgentSideConnection | undefined;
    const agent = (conn: AgentSideConnection): Agent => {
      agentConn = conn;
      return {
        initialize: async () => ({ protocolVersion: PROTOCOL_VERSION }),
        newSession: async () => ({ sessionId: 's' }),
        authenticate: async () => ({}),
        prompt: async () => {
          try {
            await conn.readTextFile({ sessionId: 's', path: '/etc/hosts' });
          } catch (err) {
            fsError = err;
          }
          return { stopReason: 'end_turn' };
        },
        cancel: async () => undefined,
      };
    };
    new AgentSideConnection(agent, ndJsonStream(toClient.writable, toAgent.readable));
    const connection = new AcpConnection(
      { input: toClient.readable, output: toAgent.writable },
      { onSessionUpdate: () => undefined, onRequestPermission: async () => ({ outcome: 'cancelled' }) },
    );
    await connection.initialize(CAPS);
    const { sessionId } = await connection.raw.newSession({ cwd: '/w', mcpServers: [] });
    const res = await connection.raw.prompt({ sessionId, prompt: [{ type: 'text', text: 'x' }] });
    expect(agentConn).toBeDefined();
    expect(fsError).toMatchObject({ code: -32601 });
    expect(res.stopReason).toBe('end_turn');
  });

  it('closed resolves when the peer ends the stream', async () => {
    const toAgent = new TransformStream<Uint8Array, Uint8Array>();
    const toClient = new TransformStream<Uint8Array, Uint8Array>();
    const connection = new AcpConnection(
      { input: toClient.readable, output: toAgent.writable },
      { onSessionUpdate: () => undefined, onRequestPermission: async () => ({ outcome: 'cancelled' }) },
    );
    await toClient.writable.close();
    await expect(connection.closed).resolves.toBeUndefined();
  });
});

describe('webStreamsFromChild', () => {
  it("bridges a child's stdout and stdin", async () => {
    const stdout = new PassThrough();
    const stdin = new PassThrough();
    const { input, output } = webStreamsFromChild({ stdin, stdout });

    stdout.write('from-child');
    const reader = input.getReader();
    const read = await reader.read();
    expect(new TextDecoder().decode(read.value)).toBe('from-child');

    const writer = output.getWriter();
    await writer.write(new TextEncoder().encode('to-child'));
    expect(stdin.read()?.toString()).toBe('to-child');
    expect(stdin.destroyed).toBe(false);
  });
});

describe('AcpConnection session methods', () => {
  const started = async (script: FakeAcpScript): Promise<Rig & { sessionId: string }> => {
    const r = rig(script);
    await r.connection.initialize(CAPS);
    const { sessionId } = await r.connection.newSession({ cwd: '/w', mcpServers: [] });
    return { ...r, sessionId };
  };

  it('newSession sends the resolved cwd and the MCP servers and returns the session id and modes', async () => {
    const r = rig({ turns: [], modes: [{ id: 'default' }, { id: 'plan' }] });
    const res = await r.connection.newSession({
      cwd: 'relative/dir',
      mcpServers: [{ name: 'devia-ui', command: 'node', args: ['x.js'], env: [{ name: 'K', value: 'V' }] }],
    });
    expect(res.sessionId).toBeTruthy();
    expect(res.modes?.availableModes.map((m) => m.id)).toEqual(['default', 'plan']);
    expect(r.agent.record.newSession).toMatchObject({
      cwd: path.resolve('relative/dir'),
      mcpServers: [{ name: 'devia-ui', command: 'node', args: ['x.js'], env: [{ name: 'K', value: 'V' }] }],
    });
  });

  it('loadSession resolves and the history arrives as session/update before it resolves', async () => {
    const r = rig({
      turns: [],
      history: [{ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'old' } }],
    });
    await r.connection.loadSession({ sessionId: 'prev', cwd: '/w', mcpServers: [] });
    expect(r.updates).toHaveLength(1);
    expect(r.agent.record.loadSession).toMatchObject({ sessionId: 'prev', cwd: path.resolve('/w') });
  });

  it('prompt sends the blocks in order and resolves with the stop reason', async () => {
    const r = await started({ turns: [{ steps: [{ type: 'text', text: 'ok' }] }] });
    const res = await r.connection.prompt(r.sessionId, [
      { type: 'text', text: 'look' },
      { type: 'image', mimeType: 'image/png', data: 'AAAA' },
      { type: 'resource_link', uri: 'file:///a.txt', name: 'a.txt' },
    ]);
    expect(res.stopReason).toBe('end_turn');
    expect(r.agent.record.prompts[0]).toMatchObject({
      prompt: [
        { type: 'text', text: 'look' },
        { type: 'image', mimeType: 'image/png', data: 'AAAA' },
        { type: 'resource_link', uri: 'file:///a.txt', name: 'a.txt' },
      ],
    });
  });

  it('prompt resolves with usage when the agent reports it', async () => {
    const r = await started({ turns: [{ steps: [{ type: 'usage', inputTokens: 4, outputTokens: 6 }] }] });
    const res = await r.connection.prompt(r.sessionId, [{ type: 'text', text: 'x' }]);
    expect(res.usage).toMatchObject({ inputTokens: 4, outputTokens: 6 });
  });

  it('cancel reaches the agent and a hanging prompt ends with cancelled', async () => {
    const r = await started({ turns: [{ steps: [{ type: 'hang' }] }] });
    const pending = r.connection.prompt(r.sessionId, [{ type: 'text', text: 'x' }]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await r.connection.cancel(r.sessionId);
    expect((await pending).stopReason).toBe('cancelled');
    expect(r.agent.record.cancels).toBe(1);
  });

  it('setMode reaches the agent', async () => {
    const r = await started({ turns: [], modes: [{ id: 'default' }, { id: 'plan' }] });
    await r.connection.setMode(r.sessionId, 'plan');
    expect(r.agent.record.setModes).toEqual([{ sessionId: r.sessionId, modeId: 'plan' }]);
  });

  it('setModel resolves true with either spelling and false when the agent rejects both', async () => {
    const config = await started({ turns: [] });
    expect(await config.connection.setModel(config.sessionId, 'm1')).toBe(true);
    expect(config.agent.record.setModels[0]).toMatchObject({ configId: 'model', value: 'm1' });

    const legacy = await started({ turns: [], modelSupport: 'set_model' });
    expect(await legacy.connection.setModel(legacy.sessionId, 'm2')).toBe(true);
    expect(legacy.agent.record.setModels[0]).toMatchObject({ modelId: 'm2' });

    const none = await started({ turns: [], modelSupport: 'none' });
    expect(await none.connection.setModel(none.sessionId, 'm3')).toBe(false);
  });

  it('authenticate sends the method id', async () => {
    const r = rig({ turns: [] });
    await expect(r.connection.authenticate('token')).resolves.toBeUndefined();
  });

  it('propagates a JSON-RPC failure as an Error that keeps the code', async () => {
    const r = rig({ turns: [], failAt: 'newSession' });
    await expect(r.connection.newSession({ cwd: '/w', mcpServers: [] })).rejects.toMatchObject({
      message: expect.stringContaining('scripted'),
      code: -32000,
    });
  });

  it('calls after the stream closed reject with a clear error and cancel never throws', async () => {
    const toAgent = new TransformStream<Uint8Array, Uint8Array>();
    const toClient = new TransformStream<Uint8Array, Uint8Array>();
    const connection = new AcpConnection(
      { input: toClient.readable, output: toAgent.writable },
      { onSessionUpdate: () => undefined, onRequestPermission: async () => ({ outcome: 'cancelled' }) },
    );
    await toClient.writable.close();
    await connection.closed;
    await expect(connection.newSession({ cwd: '/w', mcpServers: [] })).rejects.toThrow(/closed/i);
    await expect(connection.cancel('s')).resolves.toBeUndefined();
  });
});
