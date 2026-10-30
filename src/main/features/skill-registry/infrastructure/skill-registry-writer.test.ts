import { describe, it, expect } from 'vitest';
import { renderSkillRegistry } from './skill-registry-writer';

/**
 * Writer-side tests — fully deterministic, no I/O. We only care about
 * the rendered Markdown shape and the LLM-facing contract sections.
 */

const projectPath = '/repos/proj';

describe('renderSkillRegistry', () => {
  it('includes the LLM contract preamble', () => {
    const md = renderSkillRegistry([
      { name: 'a', description: 'd', scope: 'project', path: '/repos/proj/.agents/skills/a' },
    ], projectPath);
    expect(md).toContain('How to use this index');
    expect(md).toContain('SKILL.md');
    expect(md).toContain('source of truth');
  });

  it('renders the empty-state body when no entries are supplied', () => {
    const md = renderSkillRegistry([], projectPath);
    expect(md).toContain('No skills detected');
    expect(md).not.toContain('| Name |');
  });

  it('renders a GFM table with all four columns', () => {
    const md = renderSkillRegistry([
      { name: 'x', description: 'y', scope: 'project', path: '/repos/proj/x' },
    ], projectPath);
    expect(md).toContain('| Name | Trigger / description | Scope | Path |');
    expect(md).toContain('|------|-----------------------|-------|------|');
  });

  it('is deterministic for the same input — byte-identical output across calls', () => {
    const entries = [
      { name: 'b', description: 'B', scope: 'project' as const, path: '/repos/proj/b' },
      { name: 'a', description: 'A', scope: 'global' as const, path: '/home/x/a' },
    ];
    const out1 = renderSkillRegistry(entries, projectPath);
    const out2 = renderSkillRegistry(entries, projectPath);
    expect(out2).toBe(out1);
  });
});
