import { describe, it, expect } from 'vitest';
import { parseClaudeTranscript, splitTranscriptLines } from './claude-transcript';

const SID = '3c8ebbae-a156-40ce-b099-50c88babeab9';
const CWD = '/Users/dherrero/repos/Eviatech/devia';

function line(extra: Record<string, unknown>): Record<string, unknown> {
  return { sessionId: SID, cwd: CWD, isSidechain: false, ...extra };
}

describe('parseClaudeTranscript', () => {
  it('returns null on empty / garbage input', () => {
    expect(parseClaudeTranscript([])).toBeNull();
    expect(parseClaudeTranscript([null, 42, 'x', { type: 'queue-operation' }])).toBeNull();
  });

  it('parses a user turn + an aggregated assistant turn with tool_use/tool_result', () => {
    const lines = [
      line({ type: 'queue-operation', operation: 'enqueue', timestamp: '2026-06-04T17:32:42.000Z' }),
      line({ type: 'user', uuid: 'u1', timestamp: '2026-06-04T17:32:42.100Z',
        message: { role: 'user', content: [{ type: 'text', text: 'haz X' }] } }),
      line({ type: 'ai-title', aiTitle: 'Hacer X en la app' }),
      // assistant turn split across two lines: thinking + tool_use, then text
      line({ type: 'assistant', uuid: 'a1', timestamp: '2026-06-04T17:32:43.000Z',
        message: { id: 'msg_1', role: 'assistant', model: 'claude-opus-4-8',
          content: [{ type: 'thinking', thinking: 'pienso' }, { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/x' } }],
          usage: { input_tokens: 10, output_tokens: 5 } } }),
      // tool result arrives as a user line — must fold into the assistant turn
      line({ type: 'user', uuid: 'u2', timestamp: '2026-06-04T17:32:43.500Z',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'file contents' }] } }),
      line({ type: 'assistant', uuid: 'a2', timestamp: '2026-06-04T17:32:44.000Z',
        message: { id: 'msg_2', role: 'assistant', model: 'claude-opus-4-8',
          content: [{ type: 'text', text: 'listo' }], usage: { input_tokens: 20, output_tokens: 8 } } }),
    ];

    const parsed = parseClaudeTranscript(lines);
    expect(parsed).not.toBeNull();
    if (!parsed) return;

    expect(parsed.agentSessionId).toBe(SID);
    expect(parsed.cwd).toBe(CWD);
    expect(parsed.title).toBe('Hacer X en la app');
    expect(parsed.createdAt).toBe(Date.parse('2026-06-04T17:32:42.000Z'));
    expect(parsed.updatedAt).toBe(Date.parse('2026-06-04T17:32:44.000Z'));

    // user bubble + ONE aggregated assistant message (both assistant lines merged)
    expect(parsed.messages).toHaveLength(2);
    const user = parsed.messages[0]!;
    const asst = parsed.messages[1]!;
    expect(user.role).toBe('user');
    expect(user.text).toBe('haz X');

    expect(asst.role).toBe('assistant');
    expect(asst.agentId).toBe('claude');
    expect(asst.model).toBe('claude-opus-4-8');
    expect(asst.thinking).toBe('pienso');
    expect(asst.text).toBe('listo');
    expect(asst.toolCalls).toHaveLength(1);
    expect(asst.toolCalls?.[0]).toMatchObject({ id: 'tu1', name: 'Read', result: 'file contents', isError: false });
    // last usage wins
    expect(asst.usage?.inputTokens).toBe(20);
    expect(asst.usage?.outputTokens).toBe(8);
  });

  it('excludes sidechain (subagent) lines', () => {
    const lines = [
      line({ type: 'user', uuid: 'u1', timestamp: '2026-06-04T17:00:00.000Z',
        message: { role: 'user', content: [{ type: 'text', text: 'principal' }] } }),
      line({ type: 'assistant', uuid: 'sc', isSidechain: true, timestamp: '2026-06-04T17:00:01.000Z',
        message: { id: 'm', role: 'assistant', content: [{ type: 'text', text: 'soy subagente' }] } }),
      line({ type: 'assistant', uuid: 'a1', timestamp: '2026-06-04T17:00:02.000Z',
        message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'respuesta real' }] } }),
    ];
    const parsed = parseClaudeTranscript(lines);
    expect(parsed?.messages).toHaveLength(2);
    expect(parsed?.messages[1]?.text).toBe('respuesta real');
  });

  it('derives a title from the first user text when no ai-title exists', () => {
    const parsed = parseClaudeTranscript([
      line({ type: 'user', uuid: 'u1', timestamp: '2026-06-04T17:00:00.000Z',
        message: { role: 'user', content: 'arregla el bug del login que rompe en prod' } }),
      line({ type: 'assistant', uuid: 'a1', timestamp: '2026-06-04T17:00:01.000Z',
        message: { id: 'm', role: 'assistant', content: [{ type: 'text', text: 'ok' }] } }),
    ]);
    expect(parsed?.title).toBe('arregla el bug del login que rompe en prod');
  });
});

describe('splitTranscriptLines', () => {
  it('parses JSONL, skipping blank and corrupt lines', () => {
    const text = '{"a":1}\n\n  \nnot json\n{"b":2}\n';
    expect(splitTranscriptLines(text)).toEqual([{ a: 1 }, { b: 2 }]);
  });
});
