import { describe, it, expect } from 'vitest';
import { parseSubAgentFile, renderSubAgentFile } from './frontmatter';

describe('parseSubAgentFile', () => {
  it('parses the Claude-flavoured comma-separated tools list', () => {
    const raw = [
      '---',
      'name: code-reviewer',
      'description: Senior reviewer.',
      'tools: Read, Grep, Edit',
      'model: sonnet',
      '---',
      '',
      '# body',
    ].join('\n');
    const { frontmatter, body } = parseSubAgentFile(raw);
    expect(frontmatter.name).toBe('code-reviewer');
    expect(frontmatter.tools).toEqual(['Read', 'Grep', 'Edit']);
    expect(frontmatter.model).toBe('sonnet');
    expect(body.trim()).toBe('# body');
  });

  it('parses the YAML-array tools form Cursor uses', () => {
    const raw = [
      '---',
      'name: x',
      'tools: [Read, Grep, "Edit"]',
      '---',
      'body',
    ].join('\n');
    const { frontmatter } = parseSubAgentFile(raw);
    expect(frontmatter.tools).toEqual(['Read', 'Grep', 'Edit']);
  });

  it('returns empty frontmatter when no fence is present', () => {
    const raw = 'just a plain body without front-matter';
    const { frontmatter, body } = parseSubAgentFile(raw);
    expect(frontmatter).toEqual({});
    expect(body).toBe(raw);
  });

  it('round-trips through render → parse with the same shape', () => {
    const rendered = renderSubAgentFile(
      {
        name: 'x',
        description: 'description with: colon',
        tools: ['Read', 'Grep'],
        model: 'sonnet',
        readonly: true,
        devia_managed: true,
        agents: ['claude', 'cursor-agent'],
      },
      '# body\nline 2',
    );
    const { frontmatter, body } = parseSubAgentFile(rendered);
    expect(frontmatter.name).toBe('x');
    expect(frontmatter.description).toBe('description with: colon');
    expect(frontmatter.tools).toEqual(['Read', 'Grep']);
    expect(frontmatter.model).toBe('sonnet');
    expect(frontmatter.readonly).toBe(true);
    expect(frontmatter.devia_managed).toBe(true);
    expect(frontmatter.agents).toEqual(['claude', 'cursor-agent']);
    expect(body.trim()).toBe('# body\nline 2');
  });

  it('quotes values that contain YAML metacharacters', () => {
    const rendered = renderSubAgentFile({ name: 'a', description: 'has: colon, comma' }, 'b');
    expect(rendered).toContain('"has: colon, comma"');
  });
});
