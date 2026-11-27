import { describe, it, expect, vi } from 'vitest';
import { registerCliAdaptersIpc } from './cli-adapters.ipc';
import { IPC } from '../../../../shared/contracts/ipc-channels';

function setup(accepted = true) {
  const handles = new Map<string, (...a: unknown[]) => unknown>();
  const send = vi.fn();
  const ctx = { ipc: { handle: (c: string, f: (...a: unknown[]) => unknown) => handles.set(c, f) }, send } as never;
  registerCliAdaptersIpc(ctx, {
    listAgents: {} as never,
    selectAgent: { execute: () => ({ agentId: 'codex', accepted }) } as never,
    setAgentModel: {} as never,
    setAgentEnv: {} as never,
    testAgent: {} as never,
    setContextAgent: { execute: () => ({ accepted, effective: { agentId: 'codex', source: 'project' } }) } as never,
    getEffectiveAgent: { execute: () => ({ agentId: 'claude', source: 'global' }) } as never,
  });
  return { handles, send };
}

describe('cli-adapters IPC — effective agent (S-53)', () => {
  it('announces the changed project after an accepted context change', () => {
    const t = setup();
    t.handles.get(IPC.agentSetContext)!({}, { scope: 'project', projectPath: 'a', agentId: 'codex' });
    expect(t.send).toHaveBeenCalledWith('agents:effective-changed', { projectPath: 'a' });
  });

  it('announces nothing when the change is rejected', () => {
    const t = setup(false);
    t.handles.get(IPC.agentSetContext)!({}, { scope: 'project', projectPath: 'a', agentId: 'codex' });
    expect(t.send).not.toHaveBeenCalledWith('agents:effective-changed', expect.anything());
  });

  it('a global default change announces a change for every project', () => {
    const t = setup();
    t.handles.get(IPC.agentSelect)!({}, 'codex');
    expect(t.send).toHaveBeenCalledWith('agents:effective-changed', {});
  });

  it('answers the effective agent query', () => {
    const t = setup();
    expect(t.handles.get(IPC.agentEffective)!({}, { projectPath: 'a' })).toEqual({ agentId: 'claude', source: 'global' });
  });
});
