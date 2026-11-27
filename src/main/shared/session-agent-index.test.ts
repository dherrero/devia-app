import { describe, it, expect, vi } from 'vitest';
import { SessionAgentIndex } from './session-agent-index';
import type { PersistedSession } from '../../shared/domain/session';

const SID = '11111111-2222-3333-4444-555555555555';

function setup(seed: Partial<PersistedSession> | null = { id: SID, project: 'p', createdAt: 1, updatedAt: 2, messages: [] }) {
  let stored: PersistedSession | null = seed ? ({ id: SID, project: 'p', createdAt: 1, updatedAt: 2, messages: [], ...seed } as PersistedSession) : null;
  const load = vi.fn(() => stored);
  const save = vi.fn((_p: string, s: PersistedSession) => { stored = s; });
  const index = new SessionAgentIndex({ sessions: { load, save } });
  return { index, load, save, stored: () => stored };
}

describe('SessionAgentIndex', () => {
  it('reads the stored agent once and then serves it from memory', () => {
    const t = setup({ preferredAgentId: 'codex' });
    expect(t.index.get('p', SID)).toBe('codex');
    expect(t.index.get('p', SID)).toBe('codex');
    expect(t.load).toHaveBeenCalledOnce();
  });

  it('returns null for a session without an agent or that does not exist', () => {
    expect(setup().index.get('p', SID)).toBeNull();
    expect(setup(null).index.get('p', SID)).toBeNull();
  });

  it('writes the agent into an existing session without touching the rest of it', () => {
    const t = setup({ messages: [{ id: 'm' }] });
    t.index.set('p', SID, 'pi');
    expect(t.save).toHaveBeenCalledOnce();
    expect(t.stored()).toMatchObject({ id: SID, preferredAgentId: 'pi', messages: [{ id: 'm' }] });
    expect(t.index.get('p', SID)).toBe('pi');
  });

  it('removes the agent when set to null', () => {
    const t = setup({ preferredAgentId: 'pi' });
    t.index.set('p', SID, null);
    expect(t.stored()?.preferredAgentId).toBeUndefined();
    expect(t.index.get('p', SID)).toBeNull();
  });

  it('keeps the choice for a session that is not on disk yet, and writes nothing', () => {
    const t = setup(null);
    t.index.set('p', SID, 'codex');
    expect(t.save).not.toHaveBeenCalled();
    expect(t.index.get('p', SID)).toBe('codex');
  });

  it('hands the pending choice to the first save of that session, once', () => {
    const t = setup(null);
    t.index.set('p', SID, 'codex');
    expect(t.index.resolveForSave('p', SID, undefined)).toBe('codex');
    // later saves keep what is already stored
    expect(t.index.resolveForSave('p', SID, 'codex')).toBe('codex');
  });

  it('a save of a session with no pending choice keeps the stored agent', () => {
    const t = setup();
    expect(t.index.resolveForSave('p', SID, 'pi')).toBe('pi');
    expect(t.index.resolveForSave('p', SID, undefined)).toBeUndefined();
  });

  it('cancelling a pending choice leaves nothing behind', () => {
    const t = setup(null);
    t.index.set('p', SID, 'codex');
    t.index.set('p', SID, null);
    expect(t.index.get('p', SID)).toBeNull();
    expect(t.index.resolveForSave('p', SID, undefined)).toBeUndefined();
  });
});
