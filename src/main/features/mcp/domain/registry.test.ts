import { describe, expect, it } from 'vitest';

import { McpServerRegistry } from './registry';

describe('McpServerRegistry.editView', () => {
  const registry = new McpServerRegistry([
    {
      id: 'a', name: 'A', description: 'd', command: 'node', args: ['x.cjs'], env: { TOKEN: 'secret' },
      allowedEnvKeys: ['K'], enabled: false, agents: ['gemini'], scope: 'project', source: 'npm', exposure: 'codemode',
    },
    { id: 'b', name: 'B', command: 'node', args: [], enabled: true },
  ]);

  it('returns the server with its env values, which the list view redacts', () => {
    expect(registry.editView('a')).toEqual({
      id: 'a', name: 'A', description: 'd', command: 'node', args: ['x.cjs'], env: { TOKEN: 'secret' },
      allowedEnvKeys: ['K'], enabled: false, agents: ['gemini'], scope: 'project', source: 'npm', exposure: 'codemode',
    });
    expect(JSON.stringify(registry.list())).not.toContain('secret');
  });

  it('applies the same defaults as the list for a server without agents, scope or source', () => {
    expect(registry.editView('b')).toEqual({
      id: 'b', name: 'B', command: 'node', args: [], enabled: true, agents: ['claude'], scope: 'global', source: 'manual',
    });
  });

  it('returns null for an unknown id', () => {
    expect(registry.editView('nope')).toBeNull();
  });

  it('hands out a copy, so editing the result cannot change the catalog', () => {
    const view = registry.editView('a');
    view?.args.push('mutated');
    if (view?.env) view.env['TOKEN'] = 'changed';
    expect(registry.editView('a')?.args).toEqual(['x.cjs']);
    expect(registry.editView('a')?.env).toEqual({ TOKEN: 'secret' });
  });
});
