import { describe, expect, it } from 'vitest';

import type { McpServerConfig } from '../../../../shared/domain/mcp';
import { partitionMcpServers } from './partition';

function server(id: string, exposure?: McpServerConfig['exposure']): McpServerConfig {
  return { id, name: id, command: 'node', args: [], enabled: true, ...(exposure !== undefined && { exposure }) };
}

describe('partitionMcpServers', () => {
  it('keeps everything direct when no server declares an exposure', () => {
    const out = partitionMcpServers([server('a'), server('b')]);
    expect(out.direct.map((s) => s.id)).toEqual(['a', 'b']);
    expect(out.codeMode).toEqual([]);
  });

  it('moves exposure "codemode" servers out of direct', () => {
    const out = partitionMcpServers([server('a'), server('b', 'codemode')]);
    expect(out.direct.map((s) => s.id)).toEqual(['a']);
    expect(out.codeMode.map((s) => s.id)).toEqual(['b']);
  });

  it('never moves an excluded id into code mode', () => {
    const out = partitionMcpServers([server('devia-memory', 'codemode')], { excludeIds: ['devia-memory'] });
    expect(out.direct.map((s) => s.id)).toEqual(['devia-memory']);
    expect(out.codeMode).toEqual([]);
  });

  it('treats deferred and hidden as direct (no behaviour change)', () => {
    const out = partitionMcpServers([server('a', 'deferred'), server('b', 'hidden')]);
    expect(out.direct.map((s) => s.id)).toEqual(['a', 'b']);
    expect(out.codeMode).toEqual([]);
  });

  it('preserves input order inside each side', () => {
    const out = partitionMcpServers([server('z', 'codemode'), server('a'), server('m', 'codemode'), server('b')]);
    expect(out.codeMode.map((s) => s.id)).toEqual(['z', 'm']);
    expect(out.direct.map((s) => s.id)).toEqual(['a', 'b']);
  });
});
