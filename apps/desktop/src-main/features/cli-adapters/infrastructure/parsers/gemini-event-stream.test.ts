import { describe, it, expect } from 'vitest';
import { createGeminiEventStreamParser } from './gemini-event-stream';
import type { AgentEvent } from '../../domain/stream-parser';

function makeParser() {
  const events: AgentEvent[] = [];
  const parser = createGeminiEventStreamParser((e) => events.push(e));
  return { events, parser };
}

function feed(p: ReturnType<typeof makeParser>, ...lines: string[]) {
  for (const line of lines) {
    p.parser.feed(line + '\n');
  }
}

describe('createGeminiEventStreamParser', () => {
  it('text field emits text_delta', () => {
    const p = makeParser();
    feed(p, JSON.stringify({ type: 'text', text: 'Hello from Gemini' }));
    const textEvents = p.events.filter((e) => e.type === 'text_delta');
    expect(textEvents).toHaveLength(1);
    const te = textEvents[0] as Extract<AgentEvent, { type: 'text_delta' }>;
    expect(te.delta).toBe('Hello from Gemini');
  });

  it('delta field emits text_delta', () => {
    const p = makeParser();
    feed(p, JSON.stringify({ delta: 'Incremental text' }));
    const textEvents = p.events.filter((e) => e.type === 'text_delta');
    expect(textEvents).toHaveLength(1);
    expect((textEvents[0] as Extract<AgentEvent, { type: 'text_delta' }>).delta).toBe('Incremental text');
  });

  it('model info event emits status with model', () => {
    const p = makeParser();
    feed(p, JSON.stringify({ type: 'init', model: 'gemini-2.0-flash' }));
    const statusEvents = p.events.filter((e) => e.type === 'status');
    expect(statusEvents).toHaveLength(1);
    const se = statusEvents[0] as Extract<AgentEvent, { type: 'status' }>;
    expect(se.model).toBe('gemini-2.0-flash');
    expect(se.label).toBe('initializing');
  });

  it('start event emits status', () => {
    const p = makeParser();
    feed(p, JSON.stringify({ type: 'start', model: 'gemini-1.5-pro' }));
    const statusEvents = p.events.filter((e) => e.type === 'status');
    expect(statusEvents).toHaveLength(1);
  });

  it('toolCall event emits tool_use', () => {
    const p = makeParser();
    feed(p, JSON.stringify({ type: 'tool_call', toolCall: { name: 'SearchTool', id: 'tool-g-1', args: { query: 'vitest' } } }));
    const toolEvents = p.events.filter((e) => e.type === 'tool_use');
    expect(toolEvents).toHaveLength(1);
    const te = toolEvents[0] as Extract<AgentEvent, { type: 'tool_use' }>;
    expect(te.name).toBe('SearchTool');
    expect(te.id).toBe('tool-g-1');
    expect(te.input).toEqual({ query: 'vitest' });
  });

  it('event with no text and unknown type emits raw', () => {
    const p = makeParser();
    feed(p, JSON.stringify({ type: 'unknown_event_xyz' }));
    const rawEvents = p.events.filter((e) => e.type === 'raw');
    expect(rawEvents).toHaveLength(1);
  });

  it('functionCall event emits tool_use', () => {
    const p = makeParser();
    feed(p, JSON.stringify({ type: 'function', functionCall: { name: 'RunCode', id: 'fn-1', args: { code: 'print("hi")' } } }));
    const toolEvents = p.events.filter((e) => e.type === 'tool_use');
    expect(toolEvents).toHaveLength(1);
    const te = toolEvents[0] as Extract<AgentEvent, { type: 'tool_use' }>;
    expect(te.name).toBe('RunCode');
  });

  // REV-TS-CLI-14-02: cover tool object fallback (no toolCall / functionCall)
  it('tool object fallback emits tool_use when no toolCall/functionCall', () => {
    const p = makeParser();
    feed(p, JSON.stringify({ type: 'tool_call', tool: { name: 'FallbackTool' } }));
    const toolEvents = p.events.filter((e) => e.type === 'tool_use');
    expect(toolEvents).toHaveLength(1);
    const te = toolEvents[0] as Extract<AgentEvent, { type: 'tool_use' }>;
    expect(te.name).toBe('FallbackTool');
  });

  // REV-TS-CLI-14-02: cover content field as text source
  it('content field emits text_delta', () => {
    const p = makeParser();
    feed(p, JSON.stringify({ content: 'from content field' }));
    const textEvents = p.events.filter((e) => e.type === 'text_delta');
    expect(textEvents).toHaveLength(1);
    expect((textEvents[0] as Extract<AgentEvent, { type: 'text_delta' }>).delta).toBe('from content field');
  });

  // REV-TS-CLI-14-02: cover flush() with buffered content
  it('flush() drains buffered content without trailing newline', () => {
    const p = makeParser();
    p.parser.feed(JSON.stringify({ text: 'flush test' }));
    expect(p.events.filter((e) => e.type === 'text_delta')).toHaveLength(0);
    p.parser.flush();
    expect(p.events.filter((e) => e.type === 'text_delta')).toHaveLength(1);
  });

  // REV-TS-CLI-14-02: cover tool kind falls through to text when no tool info
  it('tool kind with no toolInfo falls through to text extraction', () => {
    const p = makeParser();
    // type includes 'tool' but has no tool/toolCall/functionCall — only a text field
    feed(p, JSON.stringify({ type: 'tool_call', text: 'fallthrough text' }));
    const textEvents = p.events.filter((e) => e.type === 'text_delta');
    expect(textEvents).toHaveLength(1);
    expect((textEvents[0] as Extract<AgentEvent, { type: 'text_delta' }>).delta).toBe('fallthrough text');
  });
});

// ── S-19 F1.2 — verified Gemini CLI stream shape ────────────────────────────

describe('createGeminiEventStreamParser — verified shape (S-19 F1.2)', () => {
  it('message role=assistant emits text_delta from content', () => {
    const p = makeParser();
    feed(p, JSON.stringify({ type: 'message', role: 'assistant', content: 'la respuesta' }));
    const texts = p.events.filter((e) => e.type === 'text_delta');
    expect(texts).toHaveLength(1);
    expect((texts[0] as Extract<AgentEvent, { type: 'text_delta' }>).delta).toBe('la respuesta');
  });

  it('message role=user is silent (never echoes the prompt)', () => {
    const p = makeParser();
    feed(p, JSON.stringify({ type: 'message', role: 'user', content: 'mi pregunta' }));
    expect(p.events).toHaveLength(0);
  });

  it('tool_use with tool_name/tool_id/parameters emits tool_use', () => {
    const p = makeParser();
    feed(p, JSON.stringify({ type: 'tool_use', tool_id: 'call_1', tool_name: 'write_file', parameters: { file_path: 'a.ts' } }));
    const tools = p.events.filter((e) => e.type === 'tool_use');
    expect(tools).toHaveLength(1);
    const te = tools[0] as Extract<AgentEvent, { type: 'tool_use' }>;
    expect(te.name).toBe('write_file');
    expect(te.id).toBe('call_1');
    expect(te.input).toEqual({ file_path: 'a.ts' });
  });

  it('tool_use parameters as a JSON string is parsed', () => {
    const p = makeParser();
    feed(p, JSON.stringify({ type: 'tool_use', tool_id: 'c2', tool_name: 'run', parameters: '{"cmd":"ls"}' }));
    const te = p.events.find((e) => e.type === 'tool_use') as Extract<AgentEvent, { type: 'tool_use' }>;
    expect(te.input).toEqual({ cmd: 'ls' });
  });

  it('write_todos maps onto the TodoWrite renderer', () => {
    const p = makeParser();
    feed(p, JSON.stringify({ type: 'tool_use', tool_id: 't', tool_name: 'write_todos', parameters: { todos: [] } }));
    const te = p.events.find((e) => e.type === 'tool_use') as Extract<AgentEvent, { type: 'tool_use' }>;
    expect(te.name).toBe('TodoWrite');
  });

  it('tool_result (success) emits tool_result with output and isError=false', () => {
    const p = makeParser();
    feed(p, JSON.stringify({ type: 'tool_result', tool_id: 'call_1', status: 'success', output: 'written' }));
    const r = p.events.find((e) => e.type === 'tool_result') as Extract<AgentEvent, { type: 'tool_result' }>;
    expect(r.toolUseId).toBe('call_1');
    expect(r.content).toBe('written');
    expect(r.isError).toBe(false);
  });

  it('tool_result (error) sets isError and surfaces the error message', () => {
    const p = makeParser();
    feed(p, JSON.stringify({ type: 'tool_result', tool_id: 'call_2', status: 'error', error: { message: 'boom' } }));
    const r = p.events.find((e) => e.type === 'tool_result') as Extract<AgentEvent, { type: 'tool_result' }>;
    expect(r.isError).toBe(true);
    expect(r.content).toBe('boom');
  });

  it('error frame emits a visible error event (not raw)', () => {
    const p = makeParser();
    feed(p, JSON.stringify({ type: 'error', message: 'quota exceeded' }));
    const errs = p.events.filter((e) => e.type === 'error');
    expect(errs).toHaveLength(1);
    expect((errs[0] as Extract<AgentEvent, { type: 'error' }>).message).toBe('quota exceeded');
    expect(p.events.some((e) => e.type === 'raw')).toBe(false);
  });

  it('error frame with severity=warning is a non-fatal status', () => {
    const p = makeParser();
    feed(p, JSON.stringify({ type: 'error', severity: 'warning', message: 'deprecated flag' }));
    expect(p.events.filter((e) => e.type === 'error')).toHaveLength(0);
    const st = p.events.find((e) => e.type === 'status') as Extract<AgentEvent, { type: 'status' }>;
    expect(st.label).toBe('warning');
  });

  it('result with stats emits usage (tokens + duration)', () => {
    const p = makeParser();
    feed(p, JSON.stringify({ type: 'result', status: 'success', stats: { input_tokens: 100, output_tokens: 200, cached: 10, duration_ms: 2500 } }));
    const u = p.events.find((e) => e.type === 'usage') as Extract<AgentEvent, { type: 'usage' }>;
    expect(u.inputTokens).toBe(100);
    expect(u.outputTokens).toBe(200);
    expect(u.cachedInputTokens).toBe(10);
    expect(u.durationMs).toBe(2500);
  });

  it('result with error status emits an error event', () => {
    const p = makeParser();
    feed(p, JSON.stringify({ type: 'result', status: 'error', error: { message: 'failed run' } }));
    const errs = p.events.filter((e) => e.type === 'error');
    expect(errs).toHaveLength(1);
    expect((errs[0] as Extract<AgentEvent, { type: 'error' }>).message).toBe('failed run');
  });
});
