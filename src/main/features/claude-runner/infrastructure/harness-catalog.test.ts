import { describe, it, expect } from 'vitest';
import type { SubAgentView } from '../../../../shared/domain/sub-agents';
import { createHarnessCatalog } from './harness-catalog';

const skill = (name: string, absolutePath: string) => ({ name, description: `${name} skill`, absolutePath, scope: 'project' as const, agents: [] });
const sub = (name: string, agents: string[]): SubAgentView =>
  ({ name, description: `${name} role`, tools: [], agents: agents as SubAgentView['agents'], sourcePath: `/p/.devia/sub-agents/${name}.md` });

describe('createHarnessCatalog', () => {
  const catalog = createHarnessCatalog({
    skills: { list: () => ({ project: [skill('a', '/p/.claude/skills/a'), skill('b', '/p/.agents/skills/b')], global: [skill('g', '/h/.claude/skills/g'), skill('a', '/p/.claude/skills/a')] }) },
    subagents: () => [sub('reviewer', ['claude']), sub('parked', [])],
  });

  it('lists project skills before global ones, once per directory', () => {
    expect(catalog.skills('/p').map((s) => s.dir)).toEqual(['/p/.claude/skills/a', '/p/.agents/skills/b', '/h/.claude/skills/g']);
  });

  it('keeps only enabled sub-agents (a parked one targets no agent)', () => {
    expect(catalog.subagents('/p')).toEqual([{ name: 'reviewer', description: 'reviewer role', file: '/p/.devia/sub-agents/reviewer.md' }]);
  });
});
