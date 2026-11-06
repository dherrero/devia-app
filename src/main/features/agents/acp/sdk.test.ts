import { describe, expect, it } from 'vitest';
import {
  AgentSideConnection,
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type Agent,
  type Client,
} from './sdk';

function pair(): { agentStream: ReturnType<typeof ndJsonStream>; clientStream: ReturnType<typeof ndJsonStream> } {
  const toAgent = new TransformStream<Uint8Array, Uint8Array>();
  const toClient = new TransformStream<Uint8Array, Uint8Array>();
  return {
    agentStream: ndJsonStream(toClient.writable, toAgent.readable),
    clientStream: ndJsonStream(toAgent.writable, toClient.readable),
  };
}

describe('acp sdk entry point', () => {
  it('exposes the connection classes and the NDJSON stream helper', () => {
    expect(typeof ClientSideConnection).toBe('function');
    expect(typeof AgentSideConnection).toBe('function');
    expect(typeof ndJsonStream).toBe('function');
    expect(typeof PROTOCOL_VERSION).toBe('number');
  });

  it('a ClientSideConnection talks to an AgentSideConnection over in-memory streams', async () => {
    const { agentStream, clientStream } = pair();
    const agent: Agent = {
      initialize: async () => ({ protocolVersion: PROTOCOL_VERSION, agentCapabilities: {} }),
      newSession: async () => ({ sessionId: 's1' }),
      authenticate: async () => ({}),
      prompt: async () => ({ stopReason: 'end_turn' }),
      cancel: async () => {},
    };
    new AgentSideConnection(() => agent, agentStream);
    const client: Client = {
      requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
      sessionUpdate: async () => {},
    };
    const connection = new ClientSideConnection(() => client, clientStream);

    const res = await connection.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });

    expect(res.protocolVersion).toBe(PROTOCOL_VERSION);
  });
});
