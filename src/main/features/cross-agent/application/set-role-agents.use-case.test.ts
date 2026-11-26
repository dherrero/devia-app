import { describe, it, expect, vi } from 'vitest';
import { SetRoleAgentsUseCase } from './set-role-agents.use-case';

function build(known: Record<string, string> = { pi: 'cli', opencode: 'cli', claude: 'cli', apiagent: 'api' }) {
  const record: { roleAgents?: Record<string, string> } = {};
  const save = vi.fn();
  const uc = new SetRoleAgentsUseCase({
    agents: { get: (id: string) => (id in known ? { providerType: known[id] } : null) },
    projects: { getOrCreate: () => record as never },
    state: { save } as never,
  });
  return { uc, record, save };
}

describe('SetRoleAgentsUseCase', () => {
  it('stores the map on the project and persists state', () => {
    const { uc, record, save } = build();
    expect(uc.execute('proj', { implementer: 'pi', reviewer: 'opencode' })).toEqual({
      accepted: true,
      map: { implementer: 'pi', reviewer: 'opencode' },
    });
    expect(record.roleAgents).toEqual({ implementer: 'pi', reviewer: 'opencode' });
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('clears the map with {} (every role back to the main agent)', () => {
    const { uc, record } = build();
    uc.execute('proj', { implementer: 'pi' });
    uc.execute('proj', {});
    expect(record.roleAgents).toEqual({});
  });

  it('accepts the explicit main agent without looking it up as an agent id', () => {
    const { uc, record } = build();
    expect(uc.execute('proj', { implementer: 'main', reviewer: 'pi' })).toEqual({
      accepted: true,
      map: { implementer: 'main', reviewer: 'pi' },
    });
    expect(record.roleAgents).toEqual({ implementer: 'main', reviewer: 'pi' });
  });

  it('rejects an unknown agent without saving anything', () => {
    const { uc, record, save } = build();
    const r = uc.execute('proj', { implementer: 'ghost' });
    expect(r).toMatchObject({ accepted: false });
    expect(record.roleAgents).toBeUndefined();
    expect(save).not.toHaveBeenCalled();
  });

  it('rejects a provider that cannot run instructions', () => {
    const { uc, save } = build();
    expect(uc.execute('proj', { reviewer: 'apiagent' })).toMatchObject({ accepted: false });
    expect(save).not.toHaveBeenCalled();
  });

  it('rejects an unknown role and a malformed map', () => {
    const { uc, save } = build();
    expect(uc.execute('proj', { architect: 'pi' } as never)).toMatchObject({ accepted: false });
    expect(uc.execute('proj', null as never)).toMatchObject({ accepted: false });
    expect(uc.execute('', { implementer: 'pi' })).toMatchObject({ accepted: false });
    expect(save).not.toHaveBeenCalled();
  });
});
