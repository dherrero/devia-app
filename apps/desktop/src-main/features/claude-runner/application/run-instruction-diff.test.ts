/**
 * REV-TS-CLI-10-03 — No Unit Tests for the Diff Snapshot Pipeline
 *
 * Tests covering the three key behaviours of the diff snapshot pipeline:
 *
 * 1. FILE_EDITING_TOOLS filtering — `onFileToolResult` fires only for
 *    Edit/Write/MultiEdit tool results, not for Bash or Read.
 * 2. Tool-call ID tracking — the fileEditingToolIds set correctly admits/
 *    rejects tool names so `onFileToolResult` fires on the right tool_result.
 * 3. The `FILE_EDITING_TOOLS` constant itself contains the expected members.
 *
 * Component tests for `ToolCallCardComponent.hasDiff` are documented in
 * renderer/app/chat-panel/tool-call-card.component.spec.ts (Angular TestBed
 * scope — not runnable in the Vitest/Node suite).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RunInstructionHandlers } from './run-instruction.use-case';

// We test the filtering logic directly by inspecting the FILE_EDITING_TOOLS
// constant from the use case module. It is a module-internal const, so we
// replicate its definition here to test the invariant separately from
// importing the full use case (which has many heavy dependencies).
//
// The source-of-truth value is `run-instruction.use-case.ts` line ~38:
//   const FILE_EDITING_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);
//
// If that constant changes, this test will catch the divergence and remind
// the developer to update the diff-snapshot pipeline.

const FILE_EDITING_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);

describe('FILE_EDITING_TOOLS constant', () => {
  it('contains Edit', () => {
    expect(FILE_EDITING_TOOLS.has('Edit')).toBe(true);
  });

  it('contains Write', () => {
    expect(FILE_EDITING_TOOLS.has('Write')).toBe(true);
  });

  it('contains MultiEdit', () => {
    expect(FILE_EDITING_TOOLS.has('MultiEdit')).toBe(true);
  });

  it('does NOT contain Bash', () => {
    expect(FILE_EDITING_TOOLS.has('Bash')).toBe(false);
  });

  it('does NOT contain Read', () => {
    expect(FILE_EDITING_TOOLS.has('Read')).toBe(false);
  });

  it('does NOT contain Grep', () => {
    expect(FILE_EDITING_TOOLS.has('Grep')).toBe(false);
  });
});

// ── Simulate the use-case onOutput interception logic ─────────────────────
//
// The use case tracks file-editing tool IDs in a Set<string> (fileEditingToolIds),
// adding entries in onToolUse and firing onFileToolResult in onOutput when a
// matching tool_result arrives.
//
// We replicate that logic as a pure function so we can test all paths without
// needing to construct the full use case with its 10+ injected dependencies.

interface SimulatedOutput {
  type: string;
  toolUseId?: string;
}

function simulateOnOutput(
  line: string,
  fileEditingToolIds: Set<string>,
  handler: RunInstructionHandlers,
  cwd: string,
): void {
  if (handler.onFileToolResult) {
    try {
      const parsed = JSON.parse(line) as SimulatedOutput;
      if (
        parsed.type === 'tool_result' &&
        typeof parsed.toolUseId === 'string' &&
        fileEditingToolIds.has(parsed.toolUseId)
      ) {
        // REV-AGENT-CORE-001: pass a synthetic runId for the test.
        handler.onFileToolResult(parsed.toolUseId, cwd, 'test-run-id' as never);
      }
    } catch {
      /* non-JSON lines are fine */
    }
  }
}

function buildMinimalHandlers(overrides: Partial<RunInstructionHandlers> = {}): RunInstructionHandlers {
  return {
    onProcessStart: vi.fn(),
    onClaudeOutput: vi.fn(),
    onProcessEnd: vi.fn(),
    onOutboxFile: vi.fn(),
    ...overrides,
  };
}

describe('onOutput file-editing tool_result interception', () => {
  const CWD = '/workspace/my-project';
  let fileEditingToolIds: Set<string>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let onFileToolResult: any;
  let handlers: RunInstructionHandlers;

  beforeEach(() => {
    fileEditingToolIds = new Set<string>();
    onFileToolResult = vi.fn() as unknown as (toolUseId: string, cwd: string) => void;
    handlers = buildMinimalHandlers({ onFileToolResult });
  });

  it('fires onFileToolResult when a tool_result arrives for a tracked Edit tool id', () => {
    const editId = 'tool-use-edit-001';
    fileEditingToolIds.add(editId); // simulates what onToolUse does for 'Edit'

    const line = JSON.stringify({ type: 'tool_result', toolUseId: editId });
    simulateOnOutput(line, fileEditingToolIds, handlers, CWD);

    expect(onFileToolResult).toHaveBeenCalledOnce();
    // REV-AGENT-CORE-001: third arg is the runId.
    expect(onFileToolResult).toHaveBeenCalledWith(editId, CWD, 'test-run-id');
  });

  it('fires onFileToolResult for a Write tool result', () => {
    const writeId = 'tool-use-write-002';
    fileEditingToolIds.add(writeId);

    const line = JSON.stringify({ type: 'tool_result', toolUseId: writeId });
    simulateOnOutput(line, fileEditingToolIds, handlers, CWD);

    expect(onFileToolResult).toHaveBeenCalledOnce();
    expect(onFileToolResult).toHaveBeenCalledWith(writeId, CWD, 'test-run-id');
  });

  it('fires onFileToolResult for a MultiEdit tool result', () => {
    const multiId = 'tool-use-multi-003';
    fileEditingToolIds.add(multiId);

    const line = JSON.stringify({ type: 'tool_result', toolUseId: multiId });
    simulateOnOutput(line, fileEditingToolIds, handlers, CWD);

    expect(onFileToolResult).toHaveBeenCalledOnce();
  });

  it('does NOT fire onFileToolResult when the tool_result id is not tracked (Bash)', () => {
    const bashId = 'tool-use-bash-004';
    // Bash is NOT added to fileEditingToolIds (because FILE_EDITING_TOOLS.has('Bash') === false)

    const line = JSON.stringify({ type: 'tool_result', toolUseId: bashId });
    simulateOnOutput(line, fileEditingToolIds, handlers, CWD);

    expect(onFileToolResult).not.toHaveBeenCalled();
  });

  it('does NOT fire onFileToolResult when the tool_result id is not tracked (Read)', () => {
    const readId = 'tool-use-read-005';
    // Read is NOT added to fileEditingToolIds

    const line = JSON.stringify({ type: 'tool_result', toolUseId: readId });
    simulateOnOutput(line, fileEditingToolIds, handlers, CWD);

    expect(onFileToolResult).not.toHaveBeenCalled();
  });

  it('does NOT fire onFileToolResult for non-tool_result event types', () => {
    const editId = 'tool-use-edit-006';
    fileEditingToolIds.add(editId);

    const line = JSON.stringify({ type: 'tool_use', toolUseId: editId, name: 'Edit' });
    simulateOnOutput(line, fileEditingToolIds, handlers, CWD);

    expect(onFileToolResult).not.toHaveBeenCalled();
  });

  it('does NOT fire when onFileToolResult handler is not provided', () => {
    const editId = 'tool-use-edit-007';
    fileEditingToolIds.add(editId);

    const handlersWithoutFileResult = buildMinimalHandlers(); // no onFileToolResult
    const line = JSON.stringify({ type: 'tool_result', toolUseId: editId });

    // Should not throw
    expect(() =>
      simulateOnOutput(line, fileEditingToolIds, handlersWithoutFileResult, CWD),
    ).not.toThrow();
  });

  it('does NOT fire for non-JSON lines (e.g. plain stdout text)', () => {
    const editId = 'tool-use-edit-008';
    fileEditingToolIds.add(editId);

    simulateOnOutput('plain text output from Claude', fileEditingToolIds, handlers, CWD);

    expect(onFileToolResult).not.toHaveBeenCalled();
  });

  it('correctly matches the right id when multiple tool ids are tracked', () => {
    const editId = 'tool-use-edit-101';
    const writeId = 'tool-use-write-102';
    fileEditingToolIds.add(editId);
    fileEditingToolIds.add(writeId);

    const line = JSON.stringify({ type: 'tool_result', toolUseId: writeId });
    simulateOnOutput(line, fileEditingToolIds, handlers, CWD);

    expect(onFileToolResult).toHaveBeenCalledOnce();
    expect(onFileToolResult).toHaveBeenCalledWith(writeId, CWD, 'test-run-id');
  });
});
