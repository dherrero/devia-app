import { describe, it, expect, vi } from 'vitest';
import { ResetSessionUseCase } from './reset-session.use-case';
import type { ProjectRecord, ProjectRegistry } from '../../../shared/ports';

function fakeRecord(name: string): ProjectRecord {
  return {
    name,
    isRunning: false,
    newSession: false,
    activeSessionId: 'old-session',
    agentSessionId: 'old-agent-session',
    agentSessionAgentId: 'claude',
  };
}

describe('ResetSessionUseCase', () => {
  it('stops the in-flight run before clearing the session pointers (E-DSK-14)', () => {
    const record = fakeRecord('/tmp/p');
    const calls: string[] = [];
    const stopProject = vi.fn((p: string) => { calls.push(`stop:${p}`); });
    const registry = {
      stopProject,
      getOrCreate: vi.fn((p: string) => { calls.push(`getOrCreate:${p}`); return record; }),
    } as unknown as ProjectRegistry;
    const save = vi.fn();

    const ok = new ResetSessionUseCase({ registry, state: { save } as never }).execute('/tmp/p');

    expect(ok).toBe(true);
    expect(stopProject).toHaveBeenCalledWith('/tmp/p');
    // The kill MUST happen before the pointers are touched.
    expect(calls).toEqual(['stop:/tmp/p', 'getOrCreate:/tmp/p']);
    // Pointers reset so the next instruction starts a fresh native session.
    expect(record.newSession).toBe(true);
    expect(record.activeSessionId).toBeNull();
    expect(record.agentSessionId).toBeNull();
    expect(record.agentSessionAgentId).toBeNull();
    expect(save).toHaveBeenCalledOnce();
  });
});
