import { describe, it, expect } from 'vitest';
import { createCodexEventStreamParser } from './codex-event-stream';
import type { AgentEvent } from '../../domain/stream-parser';

function makeParser() {
  const events: AgentEvent[] = [];
  const parser = createCodexEventStreamParser((e) => events.push(e));
  return { events, parser };
}

function feed(p: ReturnType<typeof makeParser>, ...lines: string[]) {
  for (const line of lines) {
    p.parser.feed(line + '\n');
  }
}

function expectPresent<T>(value: T | null | undefined): T {
  expect(value).toBeDefined();
  return value as T;
}

/**
 * Tests cover the Codex 0.5+ "agentic" event stream (thread/turn/item
 * envelopes). The legacy `agent_message_delta` / `exec_command_begin`
 * shape was removed from the parser when Codex upstream switched
 * formats — those tests have been replaced with the new shapes.
 */
describe('createCodexEventStreamParser — new agentic format', () => {
  it('thread.started emits status:initializing', () => {
    const p = makeParser();
    feed(p, JSON.stringify({ type: 'thread.started', thread_id: 't1' }));
    const status = p.events.filter((e) => e.type === 'status') as Extract<AgentEvent, { type: 'status' }>[];
    expect(status).toHaveLength(1);
    expect(expectPresent(status[0]).label).toBe('initializing');
  });

  it('thread.started emits session_started with the thread id (resume handle)', () => {
    const p = makeParser();
    feed(p, JSON.stringify({ type: 'thread.started', thread_id: 't1' }));
    const sessions = p.events.filter((e) => e.type === 'session_started') as Extract<AgentEvent, { type: 'session_started' }>[];
    expect(sessions).toHaveLength(1);
    expect(expectPresent(sessions[0]).agentSessionId).toBe('t1');
  });

  it('thread.started without thread_id emits no session_started', () => {
    const p = makeParser();
    feed(p, JSON.stringify({ type: 'thread.started' }));
    expect(p.events.filter((e) => e.type === 'session_started')).toHaveLength(0);
  });

  it('mcp_tool_call started+completed emits one tool_use + one tool_result', () => {
    const p = makeParser();
    const item = {
      id: 'item_4', type: 'mcp_tool_call', server: 'devia-kanban', tool: 'kanban_list',
      arguments: { specId: 'S-1' },
    };
    feed(p,
      JSON.stringify({ type: 'item.started', item: { ...item, result: null, error: null, status: 'in_progress' } }),
      JSON.stringify({
        type: 'item.completed',
        item: {
          ...item,
          result: { content: [{ type: 'text', text: '{"specs":[]}' }], structured_content: null },
          error: null,
          status: 'completed',
        },
      }),
    );
    const uses = p.events.filter((e) => e.type === 'tool_use') as Extract<AgentEvent, { type: 'tool_use' }>[];
    const results = p.events.filter((e) => e.type === 'tool_result') as Extract<AgentEvent, { type: 'tool_result' }>[];
    expect(uses).toHaveLength(1);
    expect(expectPresent(uses[0]).name).toBe('mcp__devia-kanban__kanban_list');
    expect(expectPresent(uses[0]).input).toEqual({ specId: 'S-1' });
    expect(results).toHaveLength(1);
    expect(expectPresent(results[0]).content).toBe('{"specs":[]}');
    expect(expectPresent(results[0]).isError).toBe(false);
    // No raw passthrough — the JSONL noise the transcript showed is gone.
    expect(p.events.filter((e) => e.type === 'raw')).toHaveLength(0);
  });

  it('mcp_tool_call completed without a started still emits the tool_use', () => {
    const p = makeParser();
    feed(p, JSON.stringify({
      type: 'item.completed',
      item: {
        id: 'item_9', type: 'mcp_tool_call', server: 'devia-memory', tool: 'mem_save',
        arguments: {}, result: { content: [{ type: 'text', text: 'Saved.' }] }, error: null, status: 'completed',
      },
    }));
    expect(p.events.filter((e) => e.type === 'tool_use')).toHaveLength(1);
    expect(p.events.filter((e) => e.type === 'tool_result')).toHaveLength(1);
  });

  it('mcp_tool_call failure surfaces as tool_result isError=true', () => {
    const p = makeParser();
    feed(p, JSON.stringify({
      type: 'item.completed',
      item: {
        id: 'item_5', type: 'mcp_tool_call', server: 'devia-kanban', tool: 'kanban_list',
        arguments: {}, result: null, error: { message: 'server unavailable' }, status: 'failed',
      },
    }));
    const results = p.events.filter((e) => e.type === 'tool_result') as Extract<AgentEvent, { type: 'tool_result' }>[];
    expect(results).toHaveLength(1);
    expect(expectPresent(results[0]).isError).toBe(true);
    expect(expectPresent(results[0]).content).toBe('server unavailable');
  });

  it('turn.started emits status:running', () => {
    const p = makeParser();
    feed(p, JSON.stringify({ type: 'turn.started' }));
    const status = p.events.filter((e) => e.type === 'status') as Extract<AgentEvent, { type: 'status' }>[];
    expect(status).toHaveLength(1);
    expect(expectPresent(status[0]).label).toBe('running');
  });

  it('item.started command_execution emits tool_use:Bash', () => {
    const p = makeParser();
    feed(p, JSON.stringify({
      type: 'item.started',
      item: { id: 'cmd-1', type: 'command_execution', command: 'ls -la' },
    }));
    const toolEvents = p.events.filter((e) => e.type === 'tool_use') as Extract<AgentEvent, { type: 'tool_use' }>[];
    expect(toolEvents).toHaveLength(1);
    const toolEvent = expectPresent(toolEvents[0]);
    expect(toolEvent.name).toBe('Bash');
    expect(toolEvent.id).toBe('cmd-1');
    expect((toolEvent.input as { command: string }).command).toBe('ls -la');
  });

  it('item.completed command_execution emits tool_result (success)', () => {
    const p = makeParser();
    feed(p,
      JSON.stringify({
        type: 'item.started',
        item: { id: 'cmd-1', type: 'command_execution', command: 'ls' },
      }),
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'cmd-1', type: 'command_execution', command: 'ls', aggregated_output: 'total 42', exit_code: 0 },
      }),
    );
    const results = p.events.filter((e) => e.type === 'tool_result') as Extract<AgentEvent, { type: 'tool_result' }>[];
    expect(results).toHaveLength(1);
    const result = expectPresent(results[0]);
    expect(result.toolUseId).toBe('cmd-1');
    expect(result.content).toBe('total 42');
    expect(result.isError).toBe(false);
  });

  it('item.completed command_execution with non-zero exit_code is isError=true', () => {
    const p = makeParser();
    feed(p, JSON.stringify({
      type: 'item.completed',
      item: { id: 'cmd-x', type: 'command_execution', command: 'false', aggregated_output: 'oops', exit_code: 1 },
    }));
    const results = p.events.filter((e) => e.type === 'tool_result') as Extract<AgentEvent, { type: 'tool_result' }>[];
    expect(results).toHaveLength(1);
    expect(expectPresent(results[0]).isError).toBe(true);
  });

  it('item.completed command_execution without preceding item.started still emits tool_use+tool_result', () => {
    const p = makeParser();
    feed(p, JSON.stringify({
      type: 'item.completed',
      item: { id: 'cmd-fast', type: 'command_execution', command: 'echo hi', aggregated_output: 'hi', exit_code: 0 },
    }));
    expect(p.events.filter((e) => e.type === 'tool_use')).toHaveLength(1);
    expect(p.events.filter((e) => e.type === 'tool_result')).toHaveLength(1);
  });

  it('item.completed agent_message emits text_delta', () => {
    const p = makeParser();
    feed(p, JSON.stringify({
      type: 'item.completed',
      item: { id: 'msg-0', type: 'agent_message', text: 'Hello world' },
    }));
    const text = p.events.filter((e) => e.type === 'text_delta') as Extract<AgentEvent, { type: 'text_delta' }>[];
    expect(text).toHaveLength(1);
    expect(expectPresent(text[0]).delta).toBe('Hello world');
  });

  it('consecutive agent_messages get a newline boundary inserted', () => {
    const p = makeParser();
    feed(p,
      JSON.stringify({ type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'First' } }),
      JSON.stringify({ type: 'item.completed', item: { id: 'm2', type: 'agent_message', text: 'Second' } }),
    );
    const text = p.events.filter((e) => e.type === 'text_delta') as Extract<AgentEvent, { type: 'text_delta' }>[];
    expect(text.map((t) => t.delta)).toEqual(['First', '\nSecond']);
  });

  it('does NOT insert boundary when previous message ended with newline', () => {
    const p = makeParser();
    feed(p,
      JSON.stringify({ type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'First\n' } }),
      JSON.stringify({ type: 'item.completed', item: { id: 'm2', type: 'agent_message', text: 'Second' } }),
    );
    const text = p.events.filter((e) => e.type === 'text_delta') as Extract<AgentEvent, { type: 'text_delta' }>[];
    expect(text.map((t) => t.delta)).toEqual(['First\n', 'Second']);
  });

  it('item.completed file_change emits tool_use:Edit + tool_result', () => {
    const p = makeParser();
    feed(p, JSON.stringify({
      type: 'item.completed',
      item: {
        id: 'fc-1',
        type: 'file_change',
        changes: [{ path: 'src/foo.ts', kind: 'add' }],
      },
    }));
    expect(p.events.filter((e) => e.type === 'tool_use')).toHaveLength(1);
    const tu = p.events.find((e) => e.type === 'tool_use') as Extract<AgentEvent, { type: 'tool_use' }>;
    expect(tu.name).toBe('Edit');
    expect(p.events.filter((e) => e.type === 'tool_result')).toHaveLength(1);
  });

  it('turn.completed with usage emits usage event with all four token fields', () => {
    const p = makeParser();
    feed(p, JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 100, output_tokens: 50, cached_input_tokens: 80, reasoning_output_tokens: 600 },
    }));
    const usage = p.events.filter((e) => e.type === 'usage') as Extract<AgentEvent, { type: 'usage' }>[];
    expect(usage).toHaveLength(1);
    // AC1
    const usageEvent = expectPresent(usage[0]);
    // cached_input_tokens is a subset of input_tokens → only the uncached 20.
    expect(usageEvent.inputTokens).toBe(20);
    expect(usageEvent.outputTokens).toBe(50);
    expect(usageEvent.cachedInputTokens).toBe(80);
    expect(usageEvent.reasoningOutputTokens).toBe(600);
  });

  it('AC2: turn.completed usage omitting optional fields does not write undefined', () => {
    const p = makeParser();
    feed(p, JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 10, output_tokens: 5 },
    }));
    const usage = p.events.filter((e) => e.type === 'usage') as Extract<AgentEvent, { type: 'usage' }>[];
    expect(usage).toHaveLength(1);
    const usageEvent = expectPresent(usage[0]);
    expect(usageEvent.cachedInputTokens).toBeUndefined();
    expect(usageEvent.reasoningOutputTokens).toBeUndefined();
  });

  it('turn.failed emits a single error event', () => {
    const p = makeParser();
    feed(p, JSON.stringify({ type: 'turn.failed', error: { message: 'Model overloaded' } }));
    const errs = p.events.filter((e) => e.type === 'error') as Extract<AgentEvent, { type: 'error' }>[];
    expect(errs).toHaveLength(1);
    expect(expectPresent(errs[0]).message).toBe('Model overloaded');
  });

  it('reconnecting error converts to a status event, not an error', () => {
    const p = makeParser();
    feed(p, JSON.stringify({
      type: 'error',
      message: 'Reconnecting... timeout waiting for child process to exit',
    }));
    expect(p.events.filter((e) => e.type === 'error')).toHaveLength(0);
    expect(p.events.filter((e) => e.type === 'status')).toHaveLength(1);
  });

  it('plain error event emits one error and de-dupes subsequent ones', () => {
    const p = makeParser();
    feed(p,
      JSON.stringify({ type: 'error', message: 'Auth failed' }),
      JSON.stringify({ type: 'error', message: 'Auth failed again' }),
    );
    const errs = p.events.filter((e) => e.type === 'error');
    expect(errs).toHaveLength(1);
  });

  // T-7: model propagation from thread.started
  it('emits status with model when the thread.started frame carries a model id', () => {
    const p = makeParser();
    feed(p, JSON.stringify({ type: 'thread.started', thread_id: 't1', model: 'o4-mini' }));
    const status = p.events.find((e) => e.type === 'status') as Extract<AgentEvent, { type: 'status' }>;
    expect(status).toBeDefined();
    expect(status.model).toBe('o4-mini');
  });

  it('emits status without model when the thread.started frame has no model field', () => {
    const p = makeParser();
    feed(p, JSON.stringify({ type: 'thread.started', thread_id: 't1' }));
    const status = p.events.find((e) => e.type === 'status') as Extract<AgentEvent, { type: 'status' }>;
    expect(status?.model).toBeUndefined();
  });

  it('unknown event types emit raw', () => {
    const p = makeParser();
    feed(p, JSON.stringify({ type: 'completely_unknown_event_xyz' }));
    expect(p.events.filter((e) => e.type === 'raw')).toHaveLength(1);
  });

  it('flush() drains the buffered partial final line', () => {
    const p = makeParser();
    // Feed a line without a trailing newline.
    p.parser.feed(JSON.stringify({
      type: 'item.completed',
      item: { id: 'm1', type: 'agent_message', text: 'flushed' },
    }));
    expect(p.events).toHaveLength(0);
    p.parser.flush();
    expect(p.events.filter((e) => e.type === 'text_delta')).toHaveLength(1);
  });
});
