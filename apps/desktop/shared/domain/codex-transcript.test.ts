import { describe, it, expect } from 'vitest';
import { parseCodexTranscript } from './codex-transcript';

const UUID = '019ee68f-a940-7910-9a10-b8d68dd5dd09';
const CWD = '/Users/dev/repos/project';

/** Anonymised rollout mirroring the real codex 0.141.0 shape (session_meta +
 *  response_item records: injected first user blocks, a real user prompt, an
 *  assistant turn with a function_call + function_call_output, encrypted
 *  reasoning, a final assistant text). */
function rollout(): string {
  return [
    JSON.stringify({ timestamp: '2026-06-20T19:44:01.060Z', type: 'session_meta', payload: { id: UUID, timestamp: '2026-06-20T19:43:55.243Z', cwd: CWD, cli_version: '0.141.0' } }),
    JSON.stringify({ timestamp: '2026-06-20T19:44:01.063Z', type: 'turn_context', payload: { cwd: CWD } }),
    // First user message: synthetic AGENTS.md echo + environment_context → dropped.
    JSON.stringify({ timestamp: '2026-06-20T19:44:01.064Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [
      { type: 'input_text', text: '# AGENTS.md instructions for /Users/dev/repos/project\n\nread @CLAUDE.md' },
      { type: 'input_text', text: '<environment_context>\n  <cwd>/Users/dev/repos/project</cwd>\n</environment_context>' },
    ] } }),
    // Real human prompt.
    JSON.stringify({ timestamp: '2026-06-20T19:44:05.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Resume cómo está organizado el repo' }] } }),
    JSON.stringify({ timestamp: '2026-06-20T19:44:07.232Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Voy a mirar la estructura.' }] } }),
    JSON.stringify({ timestamp: '2026-06-20T19:44:07.233Z', type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"pwd"}', call_id: 'call_1' } }),
    JSON.stringify({ timestamp: '2026-06-20T19:44:07.441Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'call_1', output: '/Users/dev/repos/project\n' } }),
    JSON.stringify({ timestamp: '2026-06-20T19:44:09.276Z', type: 'response_item', payload: { type: 'reasoning', summary: [], encrypted_content: 'gAAAA...' } }),
    JSON.stringify({ timestamp: '2026-06-20T19:44:12.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Listo, es un monorepo.' }] } }),
  ].join('\n');
}

describe('parseCodexTranscript', () => {
  it('parses meta, drops injected first-user blocks, and aggregates the agentic turn', () => {
    const parsed = parseCodexTranscript(rollout())!;
    expect(parsed).not.toBeNull();
    expect(parsed.agentId).toBe('codex');
    expect(parsed.agentSessionId).toBe(UUID);
    expect(parsed.cwd).toBe(CWD);
    expect(parsed.resumable).toBe(true);
    // First (synthetic) user message dropped → first message is the real prompt.
    expect(parsed.messages[0]).toMatchObject({ role: 'user', text: 'Resume cómo está organizado el repo' });
    expect(parsed.title).toBe('Resume cómo está organizado el repo');
    // The whole agentic turn (both assistant texts + tool call + result) is
    // aggregated into ONE assistant message, like the Claude importer.
    expect(parsed.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    const assistant = parsed.messages[1]!;
    expect(assistant.text).toContain('Voy a mirar la estructura.');
    expect(assistant.text).toContain('Listo, es un monorepo.');
    expect(assistant.toolCalls).toHaveLength(1);
    expect(assistant.toolCalls?.[0]).toMatchObject({ name: 'exec_command', result: '/Users/dev/repos/project\n' });
    expect(assistant.toolCalls?.[0]?.input).toEqual({ cmd: 'pwd' });
  });

  it('returns null when meta id/cwd or messages are missing', () => {
    expect(parseCodexTranscript('')).toBeNull();
    expect(parseCodexTranscript(JSON.stringify({ type: 'session_meta', payload: { id: UUID, cwd: CWD } }))).toBeNull();
  });

  it('tolerates corrupt lines', () => {
    const text = rollout().split('\n');
    text.splice(2, 0, '{ not json');
    expect(parseCodexTranscript(text.join('\n'))?.agentSessionId).toBe(UUID);
  });
});
