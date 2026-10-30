import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { McpSyncWriter } from './mcp-sync-writer';
import type { McpServerConfig } from '../../../../shared/domain/mcp';
import type { McpAgentTarget } from '../domain/agent-targets';

function memoryServer(): McpServerConfig {
  return { id: 'devia-memory', name: 'Devia Memory', command: '/bin/node', args: ['server.js', '--project', '/ws/p'], env: { ELECTRON_RUN_AS_NODE: '1' }, enabled: true };
}
function kanbanServer(): McpServerConfig {
  return { id: 'devia-kanban', name: 'Devia Kanban', command: '/bin/node', args: ['kanban.js', '--project', '/ws/p'], enabled: true };
}

interface GrokSettings {
  apiKey?: string;
  mcp?: { servers?: Array<{ id: string; label?: string; enabled?: boolean; transport?: string; command?: string; args?: string[]; env?: Record<string, string> }> };
}

describe('McpSyncWriter — grok-array strategy (S-21 T-227)', () => {
  let dir: string;
  let file: string;
  let target: McpAgentTarget;
  const writer = new McpSyncWriter();

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-mcp-'));
    file = path.join(dir, 'user-settings.json');
    target = { file, strategy: 'grok-array' };
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  function read(): GrokSettings {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as GrokSettings;
  }

  it('creates mcp.servers[] with the managed servers when no file exists', () => {
    writer.write({ agent: 'grok', target, managed: [memoryServer(), kanbanServer()], parentEnv: {} });
    const servers = read().mcp?.servers ?? [];
    expect(servers.map((s) => s.id)).toEqual(['devia-memory', 'devia-kanban']);
    const mem = servers.find((s) => s.id === 'devia-memory')!;
    expect(mem).toMatchObject({ enabled: true, transport: 'stdio', command: '/bin/node' });
    expect(mem.env).toMatchObject({ ELECTRON_RUN_AS_NODE: '1' });
  });

  it('preserves unrelated top-level settings and the user\'s own servers', () => {
    fs.writeFileSync(file, JSON.stringify({
      apiKey: 'secret-key',
      mcp: { servers: [{ id: 'user-server', label: 'Mine', enabled: true, transport: 'stdio', command: 'foo' }] },
    }));
    writer.write({ agent: 'grok', target, managed: [memoryServer()], parentEnv: {} });
    const out = read();
    expect(out.apiKey).toBe('secret-key');
    expect((out.mcp?.servers ?? []).map((s) => s.id)).toEqual(['user-server', 'devia-memory']);
  });

  it('is idempotent across runs — replaces a prior managed entry by id, never duplicates', () => {
    writer.write({ agent: 'grok', target, managed: [memoryServer()], parentEnv: {} });
    writer.write({ agent: 'grok', target, managed: [memoryServer()], parentEnv: {} });
    const servers = read().mcp?.servers ?? [];
    expect(servers.filter((s) => s.id === 'devia-memory')).toHaveLength(1);
  });

  it('removes a managed server when listed in removedIds', () => {
    writer.write({ agent: 'grok', target, managed: [memoryServer(), kanbanServer()], parentEnv: {} });
    writer.write({ agent: 'grok', target, managed: [kanbanServer()], removedIds: ['devia-memory'], parentEnv: {} });
    const servers = read().mcp?.servers ?? [];
    expect(servers.map((s) => s.id)).toEqual(['devia-kanban']);
  });
});
