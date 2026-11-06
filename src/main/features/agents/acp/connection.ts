import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  RequestError,
  ndJsonStream,
  type Client,
  type LoadSessionResponse,
  type NewSessionResponse,
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

export interface AcpMcpServerSpec {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: readonly { readonly name: string; readonly value: string }[];
}

export type AcpPromptBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly mimeType: string; readonly data: string }
  | { readonly type: 'resource_link'; readonly uri: string; readonly name: string };

const MODEL_FALLBACK_CODES: readonly number[] = [-32601, -32602, -32603, -32002];

function mcpServers(specs: readonly AcpMcpServerSpec[]): NewSessionRequestServers {
  return specs.map((s) => ({
    name: s.name,
    command: s.command,
    args: [...s.args],
    env: s.env.map((e) => ({ name: e.name, value: e.value })),
  }));
}

type NewSessionRequestServers = Parameters<ClientSideConnection['newSession']>[0]['mcpServers'];

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

  private async call<T>(request: () => Promise<T>): Promise<T> {
    if (this.raw.signal.aborted) throw new Error('ACP connection closed');
    try {
      return await request();
    } catch (err) {
      if (this.raw.signal.aborted) throw new Error('ACP connection closed');
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  async authenticate(methodId: string): Promise<void> {
    await this.call(() => this.raw.authenticate({ methodId }));
  }

  newSession(params: {
    readonly cwd: string;
    readonly mcpServers: readonly AcpMcpServerSpec[];
  }): Promise<NewSessionResponse> {
    return this.call(() =>
      this.raw.newSession({ cwd: path.resolve(params.cwd), mcpServers: mcpServers(params.mcpServers) }),
    );
  }

  async loadSession(params: {
    readonly sessionId: string;
    readonly cwd: string;
    readonly mcpServers: readonly AcpMcpServerSpec[];
  }): Promise<LoadSessionResponse> {
    return this.call(() =>
      this.raw.loadSession({
        sessionId: params.sessionId,
        cwd: path.resolve(params.cwd),
        mcpServers: mcpServers(params.mcpServers),
      }),
    );
  }

  async prompt(
    sessionId: string,
    blocks: readonly AcpPromptBlock[],
  ): Promise<{ stopReason: string; usage?: unknown }> {
    const res = await this.call(() => this.raw.prompt({ sessionId, prompt: blocks.map((b) => ({ ...b })) }));
    return { stopReason: res.stopReason, ...(res.usage != null && { usage: res.usage }) };
  }

  async cancel(sessionId: string): Promise<void> {
    try {
      await this.call(() => this.raw.cancel({ sessionId }));
    } catch {
      // cancelling a dead connection is a no-op
    }
  }

  async setMode(sessionId: string, modeId: string): Promise<void> {
    await this.call(() => this.raw.setSessionMode({ sessionId, modeId }));
  }

  /** Stable `session/set_config_option` first; falls back to the older `session/set_model`. False when neither is supported. */
  async setModel(sessionId: string, modelId: string): Promise<boolean> {
    const rejected = (err: unknown): boolean =>
      typeof (err as { code?: unknown } | null)?.code === 'number' &&
      MODEL_FALLBACK_CODES.includes((err as { code: number }).code);
    try {
      await this.call(() => this.raw.setSessionConfigOption({ sessionId, configId: 'model', value: modelId }));
      return true;
    } catch (err) {
      if (!rejected(err)) throw err;
    }
    try {
      await this.call(() => this.raw.extMethod('session/set_model', { sessionId, modelId }));
      return true;
    } catch (err) {
      if (rejected(err)) return false;
      throw err;
    }
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
