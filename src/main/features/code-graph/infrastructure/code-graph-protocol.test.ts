import { describe, expect, it } from 'vitest';
import { codeGraphProtocol } from '..';

describe('codeGraphProtocol', () => {
  it('is null when the server is not registered', () => {
    expect(codeGraphProtocol({ serverRegistered: false })).toBeNull();
  });

  it('names the four tools, explore first', () => {
    const text = codeGraphProtocol({ serverRegistered: true }) ?? '';
    for (const tool of ['graph_explore', 'graph_node', 'graph_impact', 'graph_affected']) expect(text).toContain(tool);
    expect(text.indexOf('graph_explore')).toBeLessThan(text.indexOf('graph_node'));
  });

  it('stays within 80 words and never tells the agent to Read or grep', () => {
    const text = codeGraphProtocol({ serverRegistered: true }) ?? '';
    expect(text.split(/\s+/).length).toBeLessThanOrEqual(80);
    expect(text).not.toMatch(/\bRead\b/);
    expect(text).not.toMatch(/\b(use|run|try|call|fall back to)\s+`?(grep|rg|find|glob|cat|read)\b/i);
    // grep/find may only appear as what the graph tools REPLACE.
    const mentions = text.match(/\b(grep|rg|find|glob)\b/gi) ?? [];
    expect(mentions).toEqual(['grep', 'find']);
    expect(text).toContain('replace grep/find');
  });
});
