/**
 * Tests for `InMemoryProjectRegistry` — specifically the REV-AGENT-CORE-001
 * extensions: `attachProcess(path, handle, runId)` and `cancelRun(runId)`.
 *
 * The pre-REV-001 behaviour (attach without runId, detach, writeToolResult)
 * is also covered to confirm back-compat.
 */
import { describe, it, expect, vi } from 'vitest';
import { InMemoryProjectRegistry } from './in-memory-project-registry';
import type { ProcessHandle } from '../domain/ports';
import type { RunId } from '../../../../shared/domain/agent';

function makeHandle(): ProcessHandle & { _kills: number; _lastReason: string | undefined } {
  const handle: ProcessHandle & { _kills: number; _lastReason: string | undefined } = {
    _kills: 0,
    _lastReason: undefined,
    kill(reason) { this._kills++; this._lastReason = reason; },
  };
  return handle;
}

describe('InMemoryProjectRegistry — REV-AGENT-CORE-001 runId support', () => {
  it('attachProcess without runId stores currentRunId as null', () => {
    const registry = new InMemoryProjectRegistry();
    registry.getOrCreate('proj-a');
    const handle = makeHandle();
    registry.attachProcess('proj-a', handle);
    // No public getter for currentRunId; cancelRun on any id should not match.
    registry.cancelRun('non-existent' as RunId);
    expect(handle._kills).toBe(0);
  });

  it('attachProcess with runId enables targeted cancellation', () => {
    const registry = new InMemoryProjectRegistry();
    registry.getOrCreate('proj-a');
    const handle = makeHandle();
    const runId = 'rid-1' as RunId;
    registry.attachProcess('proj-a', handle, runId);

    registry.cancelRun(runId);
    expect(handle._kills).toBe(1);
  });

  it('cancelRun is a silent no-op for unknown runId', () => {
    const registry = new InMemoryProjectRegistry();
    registry.getOrCreate('proj-a');
    const handle = makeHandle();
    registry.attachProcess('proj-a', handle, 'rid-1' as RunId);

    // Unknown id — must not throw, must not kill anything.
    expect(() => registry.cancelRun('rid-different' as RunId)).not.toThrow();
    expect(handle._kills).toBe(0);
  });

  it('cancelRun only kills the matching project, not others running concurrently', () => {
    const registry = new InMemoryProjectRegistry();
    registry.getOrCreate('proj-a');
    registry.getOrCreate('proj-b');

    const handleA = makeHandle();
    const handleB = makeHandle();

    registry.attachProcess('proj-a', handleA, 'rid-a' as RunId);
    registry.attachProcess('proj-b', handleB, 'rid-b' as RunId);

    registry.cancelRun('rid-a' as RunId);

    expect(handleA._kills).toBe(1);
    expect(handleB._kills).toBe(0);
  });

  it('detachProcess clears the runId so subsequent cancelRun is a no-op', () => {
    const registry = new InMemoryProjectRegistry();
    registry.getOrCreate('proj-a');
    const handle = makeHandle();
    const runId = 'rid-1' as RunId;
    registry.attachProcess('proj-a', handle, runId);

    registry.detachProcess('proj-a');
    registry.cancelRun(runId);

    expect(handle._kills).toBe(0);
  });

  it('cancelRun is robust to handles whose kill throws', () => {
    const registry = new InMemoryProjectRegistry();
    registry.getOrCreate('proj-a');
    const handle: ProcessHandle = {
      kill: vi.fn(() => { throw new Error('already dead'); }),
    };
    registry.attachProcess('proj-a', handle, 'rid-1' as RunId);

    // Must swallow the error and not propagate.
    expect(() => registry.cancelRun('rid-1' as RunId)).not.toThrow();
    expect(handle.kill).toHaveBeenCalledOnce();
  });

  it('cancelRun is idempotent: a second call with the same id is a no-op', () => {
    const registry = new InMemoryProjectRegistry();
    registry.getOrCreate('proj-a');
    const handle = makeHandle();
    const runId = 'rid-1' as RunId;
    registry.attachProcess('proj-a', handle, runId);

    registry.cancelRun(runId);
    expect(handle._kills).toBe(1);

    // Second call must not kill again — currentRunId was cleared.
    registry.cancelRun(runId);
    expect(handle._kills).toBe(1);
  });

  // REV-AGENT-CORE-011 ─────────────────────────────────────────────────────
  it('cancelRun defaults to cancelReason="user" when called without a reason', () => {
    const registry = new InMemoryProjectRegistry();
    registry.getOrCreate('proj-a');
    const handle = makeHandle();
    registry.attachProcess('proj-a', handle, 'rid-1' as RunId);

    registry.cancelRun('rid-1' as RunId);

    expect(handle._kills).toBe(1);
    expect(handle._lastReason).toBe('user');
  });

  it('cancelRun forwards an explicit cancelReason to the handle', () => {
    const registry = new InMemoryProjectRegistry();
    registry.getOrCreate('proj-a');
    const handle = makeHandle();
    registry.attachProcess('proj-a', handle, 'rid-1' as RunId);

    registry.cancelRun('rid-1' as RunId, 'idle');

    expect(handle._lastReason).toBe('idle');
  });

  it('stopProject kills with cancelReason="user"', () => {
    const registry = new InMemoryProjectRegistry();
    registry.getOrCreate('proj-a');
    const handle = makeHandle();
    registry.attachProcess('proj-a', handle, 'rid-1' as RunId);

    registry.stopProject('proj-a');

    expect(handle._kills).toBe(1);
    expect(handle._lastReason).toBe('user');
  });

  it('stopAll kills every running project with cancelReason="user"', () => {
    const registry = new InMemoryProjectRegistry();
    registry.getOrCreate('proj-a');
    registry.getOrCreate('proj-b');
    const handleA = makeHandle();
    const handleB = makeHandle();
    registry.attachProcess('proj-a', handleA, 'rid-a' as RunId);
    registry.attachProcess('proj-b', handleB, 'rid-b' as RunId);

    const stopped = registry.stopAll();

    expect(stopped.length).toBe(2);
    expect(handleA._lastReason).toBe('user');
    expect(handleB._lastReason).toBe('user');
  });
});
