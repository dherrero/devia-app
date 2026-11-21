import { describe, expect, it } from 'vitest';

import type { McpServerConfig } from '../../../../shared/domain/mcp';
import { planCodeMode } from './plan-code-mode';

function server(id: string, exposure?: McpServerConfig['exposure']): McpServerConfig {
  return { id, name: id, command: 'node', args: [], enabled: true, ...(exposure !== undefined && { exposure }) };
}

const gateway: McpServerConfig = { id: 'devia-code-mode', name: 'g', command: 'node', args: [], enabled: true };
const injector = { serverConfig: () => gateway };
const run = (servers: McpServerConfig[], agentId = 'claude') =>
  planCodeMode({ userServers: servers, agentId, mode: 'apply', runId: 'r', injector });

describe('planCodeMode', () => {
  it('returns null when no server asks for code mode, so the run is untouched', () => {
    expect(run([server('a'), server('b', 'direct')])).toBeNull();
    expect(run([])).toBeNull();
  });

  it('moves code-mode servers behind the gateway and keeps the rest direct', () => {
    const plan = run([server('a'), server('b', 'codemode')]);
    expect(plan?.user.map((s) => s.id)).toEqual(['a']);
    expect(plan?.serverIds).toEqual(['b']);
    expect(plan?.gateway).toBe(gateway);
  });

  it('leaves the servers where they are for an agent that cannot take the gateway', () => {
    expect(run([server('b', 'codemode')], 'pi')).toBeNull();
    expect(run([server('b', 'codemode')], 'some-future-agent')).toBeNull();
  });

  it('never moves a Devia server, whatever its exposure', () => {
    const plan = run([server('devia-memory', 'codemode'), server('b', 'codemode')]);
    expect(plan?.serverIds).toEqual(['b']);
    expect(plan?.user.map((s) => s.id)).toEqual(['devia-memory']);
  });
});
