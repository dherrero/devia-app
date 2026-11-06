import { Readable, Writable } from 'node:stream';
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  RequestError,
  ndJsonStream,
  type Client,
  type RequestPermissionResponse,
} from './sdk';
import type { AcpClientCapabilities } from './profile';

export interface AcpClientHandlers {
  onSessionUpdate(sessionId: string, update: unknown): void;
  onRequestPermission(request: {
    sessionId: string;
    toolCall: unknown;
    options: readonly unknown[];
  }): Promise<{ outcome: 'selected'; optionId: string } | { outcome: 'cancelled' }>;
}

export interface AcpAgentInfo {
  readonly protocolVersion: number;
  readonly capabilities: Readonly<Record<string, unknown>>;
  readonly authMethods: readonly { id: string; name?: string }[];
}

const DEFAULT_CLIENT_INFO = { name: 'devia', version: 'desktop' };

export class AcpConnection {
  /** The SDK connection; the session methods (Task 10) are thin wrappers over it. */
  readonly raw: ClientSideConnection;

  constructor(
    streams: { readonly input: ReadableStream<Uint8Array>; readonly output: WritableStream<Uint8Array> },
    handlers: AcpClientHandlers,
    private readonly clientInfo: { name: string; version: string } = DEFAULT_CLIENT_INFO,
  ) {
    // The SDK answers an UNIMPLEMENTED fs/terminal method with a successful empty result, so each one rejects explicitly.
    const unsupported = (method: string) => async (): Promise<never> => {
      throw RequestError.methodNotFound(method);
    };
    const client: Client = {
      readTextFile: unsupported('fs/read_text_file'),
      writeTextFile: unsupported('fs/write_text_file'),
      createTerminal: unsupported('terminal/create'),
      terminalOutput: unsupported('terminal/output'),
      releaseTerminal: unsupported('terminal/release'),
      waitForTerminalExit: unsupported('terminal/wait_for_exit'),
      killTerminal: unsupported('terminal/kill'),
      sessionUpdate: async (params) => {
        handlers.onSessionUpdate(params.sessionId, params.update);
      },
      requestPermission: async (params): Promise<RequestPermissionResponse> => {
        try {
          const answer = await handlers.onRequestPermission({
            sessionId: params.sessionId,
            toolCall: params.toolCall,
            options: params.options,
          });
          return answer.outcome === 'selected'
            ? { outcome: { outcome: 'selected', optionId: answer.optionId } }
            : { outcome: { outcome: 'cancelled' } };
        } catch {
          return { outcome: { outcome: 'cancelled' } };
        }
      },
    };
    this.raw = new ClientSideConnection(() => client, ndJsonStream(streams.output, streams.input));
  }

  get closed(): Promise<void> {
    return this.raw.closed;
  }

  async initialize(clientCapabilities: AcpClientCapabilities): Promise<AcpAgentInfo> {
    const res = await this.raw.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: clientCapabilities.fs.readTextFile, writeTextFile: clientCapabilities.fs.writeTextFile },
        terminal: clientCapabilities.terminal,
      },
      clientInfo: this.clientInfo,
    });
    return {
      protocolVersion: res.protocolVersion,
      capabilities: (res.agentCapabilities ?? {}) as Record<string, unknown>,
      authMethods: (res.authMethods ?? []).map((m) => ({
        id: m.id,
        ...(typeof m.name === 'string' && { name: m.name }),
      })),
    };
  }
}

export function webStreamsFromChild(child: {
  stdin: NodeJS.WritableStream | null;
  stdout: NodeJS.ReadableStream | null;
}): { input: ReadableStream<Uint8Array>; output: WritableStream<Uint8Array> } {
  if (!child.stdin || !child.stdout) throw new Error('ACP child has no stdio pipes');
  return {
    input: Readable.toWeb(child.stdout as Readable) as ReadableStream<Uint8Array>,
    output: Writable.toWeb(child.stdin as Writable) as WritableStream<Uint8Array>,
  };
}
