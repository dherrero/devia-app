import { describe, expect, it } from 'vitest';
import type { DetectedAgentView } from '../../../../../../types/devia';
import { filterVisibleAgents, getNextAgentPanelState } from './settings-execution-section.utils';

function agent(overrides: Partial<DetectedAgentView> & Pick<DetectedAgentView, 'id' | 'name'>): DetectedAgentView {
  const { id, name, ...rest } = overrides;
  return {
    id,
    name,
    bin: rest.bin ?? id,
    streamFormat: 'plain',
    models: [],
    available: rest.available ?? true,
    providerType: rest.providerType ?? 'cli',
    applicability: rest.applicability ?? 'direct',
    selectable: rest.selectable ?? true,
    ...rest,
  };
}

describe('filterVisibleAgents', () => {
  const agents = [
    agent({ id: 'claude', name: 'Claude Code', providerType: 'cli', bin: 'claude' }),
    agent({ id: 'codex', name: 'Codex CLI', providerType: 'cli', bin: 'codex' }),
    agent({ id: 'cursor', name: 'Cursor Agent', providerType: 'api', bin: 'cursor-agent' }),
  ];

  it('filters by name and provider metadata', () => {
    expect(filterVisibleAgents(agents, 'claude', 'api').map((a) => a.id)).toEqual([
      'claude',
      'cursor',
    ]);
    expect(filterVisibleAgents(agents, 'claude', 'codex').map((a) => a.id)).toEqual([
      'claude',
      'codex',
    ]);
  });

  it('keeps the selected agent visible when it does not match the query', () => {
    expect(filterVisibleAgents(agents, 'codex', 'cursor').map((a) => a.id)).toEqual([
      'codex',
      'cursor',
    ]);
  });

  it('returns every agent when the query is blank', () => {
    expect(filterVisibleAgents(agents, 'claude', '  ').map((a) => a.id)).toEqual([
      'claude',
      'codex',
      'cursor',
    ]);
  });
});

describe('getNextAgentPanelState', () => {
  it('collapses the selected agent when its panel is already open', () => {
    expect(getNextAgentPanelState('claude', 'claude', 'claude')).toEqual({
      expandedAgentId: null,
      resetEnv: false,
      emitSelection: false,
    });
  });

  it('reopens the selected agent with environment fields folded', () => {
    expect(getNextAgentPanelState('claude', null, 'claude')).toEqual({
      expandedAgentId: 'claude',
      resetEnv: true,
      emitSelection: false,
    });
  });

  it('opens a different agent and emits selection change', () => {
    expect(getNextAgentPanelState('claude', 'claude', 'codex')).toEqual({
      expandedAgentId: 'codex',
      resetEnv: true,
      emitSelection: true,
    });
  });
});
