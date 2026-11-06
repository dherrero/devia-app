import {
  AgentSideConnection,
  PROTOCOL_VERSION,
  RequestError,
  ndJsonStream,
  type Agent,
  type RequestPermissionResponse,
  type SessionUpdate,
  type ToolCallStatus,
  type ToolKind,
} from '../sdk';

export interface FakeAcpScript {
  readonly capabilities?: Record<string, unknown>;
  readonly modes?: readonly { id: string; name?: string }[];
  readonly turns: readonly FakeAcpTurn[];
  readonly history?: readonly unknown[];
  readonly failAt?: 'initialize' | 'newSession' | 'loadSession' | 'prompt';
  /** which spelling of "set the model" the agent understands (default: config) */
  readonly modelSupport?: 'config' | 'set_model' | 'none';
}

export type FakeAcpStep =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'thought'; readonly text: string }
  | {
      readonly type: 'tool';
      readonly id: string;
      readonly title: string;
      readonly kind: string;
      readonly rawInput?: unknown;
      readonly output?: string;
      readonly fail?: boolean;
    }
  | {
      readonly type: 'permission';
      readonly toolId: string;
      readonly title: string;
      readonly kind: string;
      readonly options?: readonly { optionId: string; name: string; kind: string }[];
      /** emit the tool_call (pending) first, as real agents do */
      readonly announce?: boolean;
      /** wait this long before asking (the request lands after a cancel) */
      readonly afterMs?: number;
    }
  | { readonly type: 'plan'; readonly entries: readonly { content: string; status: string }[] }
  | { readonly type: 'usage'; readonly inputTokens: number; readonly outputTokens: number }
  | { readonly type: 'hang' }
  | { readonly type: 'crash' };

export interface FakeAcpTurn {
  readonly steps: readonly FakeAcpStep[];
  readonly stopReason?: string;
}

export interface FakeAcpRecord {
  initialize?: unknown;
  newSession?: unknown;
  loadSession?: unknown;
  prompts: unknown[];
  cancels: number;
  setModes: unknown[];
  setModels: unknown[];
  permissionAnswers: unknown[];
}

const DEFAULT_CAPABILITIES = { loadSession: true, promptCapabilities: { image: true } };
const DEFAULT_OPTIONS = [
  { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
  { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
];

function scriptedError(): RequestError {
  return new RequestError(-32000, 'scripted failure');
}

function isDenied(res: RequestPermissionResponse, options: readonly { optionId: string; kind: string }[]): boolean {
  if (res.outcome.outcome !== 'selected') return true;
  const chosen = res.outcome.optionId;
  return options.find((o) => o.optionId === chosen)?.kind.startsWith('reject') ?? false;
}

export function startFakeAcpAgent(
  script: FakeAcpScript,
  streams: { input: ReadableStream<Uint8Array>; output: WritableStream<Uint8Array> },
): { record: FakeAcpRecord; closed: Promise<void> } {
  const record: FakeAcpRecord = {
    prompts: [],
    cancels: 0,
    setModes: [],
    setModels: [],
    permissionAnswers: [],
  };
  const wire = new TransformStream<Uint8Array, Uint8Array>();
  const killWire = new AbortController();
  const closed = wire.readable.pipeTo(streams.output, { signal: killWire.signal }).catch(() => undefined);

  let turnIndex = 0;
  let sessionCounter = 0;
  let cancelled = false;
  let wakeHang: (() => void) | undefined;
  const denied = new Set<string>();

  const modeState = () =>
    script.modes
      ? {
          modes: {
            currentModeId: script.modes[0]?.id ?? 'default',
            availableModes: script.modes.map((m) => ({ id: m.id, name: m.name ?? m.id })),
          },
        }
      : {};

  const agentFor = (conn: AgentSideConnection): Agent => {
    const send = (sessionId: string, update: Record<string, unknown>): Promise<void> =>
      conn.sessionUpdate({ sessionId, update: update as SessionUpdate });

    const runStep = async (sessionId: string, step: FakeAcpStep, usage: { in: number; out: number }): Promise<void> => {
      switch (step.type) {
        case 'text':
          return send(sessionId, {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: step.text },
          });
        case 'thought':
          return send(sessionId, {
            sessionUpdate: 'agent_thought_chunk',
            content: { type: 'text', text: step.text },
          });
        case 'tool': {
          const failed = step.fail === true || denied.has(step.id);
          await send(sessionId, {
            sessionUpdate: 'tool_call',
            toolCallId: step.id,
            title: step.title,
            kind: step.kind as ToolKind,
            status: 'pending' as ToolCallStatus,
            ...(step.rawInput !== undefined && { rawInput: step.rawInput }),
          });
          return send(sessionId, {
            sessionUpdate: 'tool_call_update',
            toolCallId: step.id,
            status: (failed ? 'failed' : 'completed') as ToolCallStatus,
            ...(step.output !== undefined && {
              content: [{ type: 'content', content: { type: 'text', text: step.output } }],
            }),
          });
        }
        case 'permission': {
          const options = step.options ?? DEFAULT_OPTIONS;
          if (step.announce) {
            await send(sessionId, {
              sessionUpdate: 'tool_call',
              toolCallId: step.toolId,
              title: step.title,
              kind: step.kind as ToolKind,
              status: 'pending' as ToolCallStatus,
            });
          }
          if (step.afterMs) await new Promise((resolve) => setTimeout(resolve, step.afterMs));
          const res = await conn.requestPermission({
            sessionId,
            toolCall: { toolCallId: step.toolId, title: step.title, kind: step.kind as ToolKind },
            options: options.map((o) => ({
              optionId: o.optionId,
              name: o.name,
              kind: o.kind as 'allow_once',
            })),
          });
          record.permissionAnswers.push(res);
          if (isDenied(res, options)) denied.add(step.toolId);
          return;
        }
        case 'plan':
          return send(sessionId, {
            sessionUpdate: 'plan',
            entries: step.entries.map((e) => ({ priority: 'medium', ...e })),
          });
        case 'usage':
          usage.in += step.inputTokens;
          usage.out += step.outputTokens;
          return send(sessionId, {
            sessionUpdate: 'usage_update',
            used: usage.in + usage.out,
            size: 200_000,
          });
        case 'hang':
          if (!cancelled) await new Promise<void>((resolve) => (wakeHang = resolve));
          return;
        case 'crash':
          killWire.abort();
          await new Promise<void>(() => undefined);
      }
    };

    return {
      initialize: async (params) => {
        record.initialize = params;
        if (script.failAt === 'initialize') throw scriptedError();
        return {
          protocolVersion: PROTOCOL_VERSION,
          agentCapabilities: (script.capabilities ?? DEFAULT_CAPABILITIES) as never,
        };
      },
      authenticate: async () => ({}),
      newSession: async (params) => {
        record.newSession = params;
        if (script.failAt === 'newSession') throw scriptedError();
        sessionCounter += 1;
        return { sessionId: `fake-session-${sessionCounter}`, ...modeState() };
      },
      loadSession: async (params) => {
        record.loadSession = params;
        if (script.failAt === 'loadSession') throw scriptedError();
        for (const update of script.history ?? []) await send(params.sessionId, update as Record<string, unknown>);
        return { ...modeState() };
      },
      setSessionMode: async (params) => {
        record.setModes.push(params);
        return {};
      },
      setSessionConfigOption: async (params) => {
        if ((script.modelSupport ?? 'config') !== 'config') throw RequestError.methodNotFound('session/set_config_option');
        record.setModels.push(params);
        return { configOptions: [] };
      },
      extMethod: async (method, params) => {
        if (method !== 'session/set_model' || script.modelSupport !== 'set_model') {
          throw RequestError.methodNotFound(method);
        }
        record.setModels.push(params);
        return {};
      },
      prompt: async (params) => {
        record.prompts.push(params);
        if (script.failAt === 'prompt') throw scriptedError();
        cancelled = false;
        const turn = script.turns[Math.min(turnIndex, script.turns.length - 1)] ?? { steps: [] };
        turnIndex += 1;
        const usage = { in: 0, out: 0 };
        for (const step of turn.steps) {
          if (cancelled) break;
          await runStep(params.sessionId, step, usage);
        }
        const hadUsage = usage.in + usage.out > 0;
        return {
          stopReason: (cancelled ? 'cancelled' : (turn.stopReason ?? 'end_turn')) as 'end_turn',
          ...(hadUsage && {
            usage: {
              totalTokens: usage.in + usage.out,
              inputTokens: usage.in,
              outputTokens: usage.out,
            },
          }),
        };
      },
      cancel: async () => {
        record.cancels += 1;
        cancelled = true;
        wakeHang?.();
      },
    };
  };

  new AgentSideConnection(agentFor, ndJsonStream(wire.writable, streams.input));
  return { record, closed };
}
