import { describe, it, expect } from 'vitest';
import { summarizeToolCall } from './tool-summary';
import type { ToolCallRecord } from './chat';

function tc(overrides: Partial<ToolCallRecord> = {}): ToolCallRecord {
  return { id: 't', name: 'Bash', ...overrides };
}

describe('summarizeToolCall', () => {
  it('reports running with a tool-specific key before the result arrives', () => {
    expect(summarizeToolCall(tc({ name: 'Read' }))).toEqual({ state: 'running', key: 'tool_summary.reading' });
    expect(summarizeToolCall(tc({ name: 'Edit' }))).toEqual({ state: 'running', key: 'tool_summary.applying' });
    expect(summarizeToolCall(tc({ name: 'Bash' }))).toEqual({ state: 'running', key: 'tool_summary.executing' });
    expect(summarizeToolCall(tc({ name: 'Grep' }))).toEqual({ state: 'running', key: 'tool_summary.searching' });
    expect(summarizeToolCall(tc({ name: 'Weird' }))).toEqual({ state: 'running', key: 'tool_summary.working' });
  });

  it('treats an empty-string result as done, not running', () => {
    expect(summarizeToolCall(tc({ name: 'Write', result: '' })).state).toBe('success');
  });

  it('reports error when isError is set', () => {
    expect(summarizeToolCall(tc({ isError: true, result: 'boom' }))).toEqual({ state: 'error', key: 'tool_summary.error' });
  });

  it('counts lines for Read and matches for Grep', () => {
    expect(summarizeToolCall(tc({ name: 'Read', result: 'a\nb\nc\n' }))).toEqual({
      state: 'success', key: 'tool_summary.lines', params: { count: 3 },
    });
    expect(summarizeToolCall(tc({ name: 'Grep', result: 'hit1\nhit2' }))).toEqual({
      state: 'success', key: 'tool_summary.matches', params: { count: 2 },
    });
  });

  it('reports saved for Write', () => {
    expect(summarizeToolCall(tc({ name: 'Write', result: 'ok' }))).toEqual({ state: 'success', key: 'tool_summary.saved' });
  });

  it('counts {changes} edits from non-Claude agents', () => {
    expect(summarizeToolCall(tc({
      name: 'Edit',
      input: { changes: [{ path: 'a' }, { path: 'b' }] },
      result: 'done',
    }))).toEqual({ state: 'success', key: 'tool_summary.changes', params: { count: 2 } });
  });

  it('falls back to "edited" for an Edit with no change count', () => {
    expect(summarizeToolCall(tc({ name: 'Edit', input: { file_path: 'a.ts' }, result: 'done' }))).toEqual({
      state: 'success', key: 'tool_summary.edited',
    });
  });

  it('falls back to "done" for an unrecognised completed tool', () => {
    expect(summarizeToolCall(tc({ name: 'CustomThing', result: 'x' }))).toEqual({ state: 'success', key: 'tool_summary.done' });
  });
});
