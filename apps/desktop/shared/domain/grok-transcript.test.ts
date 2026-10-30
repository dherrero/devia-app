import { describe, it, expect } from 'vitest';
import { parseGrokTranscript } from './grok-transcript';

const SID = 'a1b2c3d4e5f6';
const CWD = '/Users/dev/repos/project';

/** Mirrors the reader's serialised aggregate: a sessions row + ordered messages
 *  whose `messageJson` is an AI-SDK ModelMessage. */
function exportJson(): string {
  return JSON.stringify({
    session: {
      id: SID, title: 'Refactor', cwdAtStart: CWD, cwdLast: CWD,
      createdAt: '2026-06-20T10:00:00.000Z', updatedAt: '2026-06-20T10:05:00.000Z',
    },
    messages: [
      { seq: 1, role: 'assistant', messageJson: JSON.stringify({ role: 'assistant', content: [{ type: 'text', text: 'Voy a mirar.' }, { type: 'tool-call', toolCallId: 't1', toolName: 'read_file', input: { path: 'a.ts' } }] }) },
      { seq: 0, role: 'user', messageJson: JSON.stringify({ role: 'user', content: 'Resume el repo' }) },
      { seq: 2, role: 'tool', messageJson: JSON.stringify({ role: 'tool', content: [{ type: 'tool-result', toolCallId: 't1', output: 'file contents' }] }) },
      { seq: 3, role: 'assistant', messageJson: JSON.stringify({ role: 'assistant', content: [{ type: 'text', text: 'Listo.' }] }) },
    ],
  });
}

describe('parseGrokTranscript (S-21 T-228)', () => {
  it('parses session metadata and aggregates the agentic turn (ordered by seq)', () => {
    const parsed = parseGrokTranscript(exportJson())!;
    expect(parsed).not.toBeNull();
    expect(parsed.agentId).toBe('grok');
    expect(parsed.agentSessionId).toBe(SID);
    expect(parsed.cwd).toBe(CWD);
    expect(parsed.resumable).toBe(true);
    expect(parsed.title).toBe('Refactor');
    // user → one aggregated assistant turn (text + tool call + result + text).
    expect(parsed.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(parsed.messages[0]).toMatchObject({ role: 'user', text: 'Resume el repo' });
    const asst = parsed.messages[1]!;
    expect(asst.text).toContain('Voy a mirar.');
    expect(asst.text).toContain('Listo.');
    expect(asst.toolCalls).toHaveLength(1);
    expect(asst.toolCalls?.[0]).toMatchObject({ name: 'read_file', input: { path: 'a.ts' }, result: 'file contents' });
  });

  it('returns null on malformed input or a session without id/cwd', () => {
    expect(parseGrokTranscript('not json')).toBeNull();
    expect(parseGrokTranscript(JSON.stringify({ session: { id: SID }, messages: [] }))).toBeNull();
    expect(parseGrokTranscript(JSON.stringify({ session: { id: SID, cwdLast: CWD }, messages: [] }))).toBeNull();
  });

  it('falls back to cwdAtStart and derives a title from the first user message', () => {
    const json = JSON.stringify({
      session: { id: SID, cwdAtStart: CWD, createdAt: '2026-06-20T10:00:00.000Z' },
      messages: [{ seq: 0, role: 'user', messageJson: JSON.stringify({ role: 'user', content: 'Hola que tal' }) }],
    });
    const parsed = parseGrokTranscript(json)!;
    expect(parsed.cwd).toBe(CWD);
    expect(parsed.title).toBe('Hola que tal');
  });
});
