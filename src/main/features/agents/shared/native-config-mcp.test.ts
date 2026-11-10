import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { McpServerConfig } from '../../../../shared/domain/mcp';
import { McpSyncWriter } from '../../mcp/infrastructure/mcp-sync-writer';
import { resolveAgentTarget } from '../../mcp/domain/agent-targets';
import { NativeConfigMcpDelivery } from './native-config-mcp';

let project: string;
let home: string;
beforeEach(() => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'devia-native-mcp-'));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'devia-native-home-'));
});
afterEach(() => {
  fs.rmSync(project, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

function server(id: string): McpServerConfig {
  return { id, name: id, command: 'node', args: [`${id}.js`], enabled: true };
}
const delivery = (): NativeConfigMcpDelivery => new NativeConfigMcpDelivery(undefined, () => home);
const readMcp = (): Record<string, Record<string, unknown>> =>
  JSON.parse(fs.readFileSync(path.join(project, 'opencode.json'), 'utf8')).mcp;

describe('NativeConfigMcpDelivery', () => {
  it('writes every Devia server in ONE file write, in the agent shape', () => {
    const out = delivery().deliver('opencode', project, [server('devia-kanban'), server('devia-memory'), server('devia-code-graph'), server('devia-ui')]);
    expect(out.file).toBe(path.join(project, 'opencode.json'));
    expect(out.deliveredServerIds).toEqual(['devia-kanban', 'devia-memory', 'devia-code-graph', 'devia-ui']);
    const mcp = readMcp();
    expect(Object.keys(mcp).sort()).toEqual(['devia-code-graph', 'devia-kanban', 'devia-memory', 'devia-ui']);
    expect(mcp['devia-ui']).toMatchObject({ type: 'local', command: ['node', 'devia-ui.js'] });
  });

  it('keeps servers the user added by hand and retires the S-24 devia-ask entry', () => {
    fs.writeFileSync(path.join(project, 'opencode.json'), JSON.stringify({
      mcp: {
        github: { type: 'local', command: ['gh-mcp'] },
        'devia-ask': { type: 'local', command: ['old'], __devia_managed: 'devia-ask' },
      },
    }));
    delivery().deliver('opencode', project, [server('devia-kanban')]);
    expect(Object.keys(readMcp()).sort()).toEqual(['devia-kanban', 'github']);
  });

  it('a later run without a server does not delete it (prune:false)', () => {
    delivery().deliver('opencode', project, [server('devia-kanban'), server('devia-ui')]);
    delivery().deliver('opencode', project, [server('devia-kanban')]);
    expect(Object.keys(readMcp()).sort()).toEqual(['devia-kanban', 'devia-ui']);
  });

  it('delivers nothing to an agent with no project MCP config', () => {
    expect(delivery().deliver('deepseek', project, [server('devia-kanban')])).toEqual({ file: null, deliveredServerIds: [] });
  });

  it('reports an empty delivery when the write fails', () => {
    const failing = new NativeConfigMcpDelivery({ write: () => { throw new Error('EACCES'); } }, () => home);
    expect(failing.deliver('opencode', project, [server('devia-ui')]).deliveredServerIds).toEqual([]);
  });
});

describe('NativeConfigMcpDelivery — stale devia-code-graph entries', () => {
  const CG = 'devia-code-graph';
  const read = (rel: string): string => fs.readFileSync(path.join(project, rel), 'utf8');
  const json = (rel: string, key = 'mcpServers'): Record<string, Record<string, unknown>> => JSON.parse(read(rel))[key] ?? {};

  it('a no-graph run removes the entry a graph run wrote (marker JSON: OpenCode, Cursor)', () => {
    for (const [agent, rel, key] of [['opencode', 'opencode.json', 'mcp'], ['cursor-agent', '.cursor/mcp.json', 'mcpServers']] as const) {
      delivery().deliver(agent, project, [server('devia-kanban'), server(CG)]);
      expect(Object.keys(json(rel, key))).toContain(CG);
      delivery().deliver(agent, project, [server('devia-kanban')]);
      expect(Object.keys(json(rel, key))).toEqual(['devia-kanban']);
    }
  });

  it('a no-graph run removes the Codex TOML block a graph run wrote', () => {
    delivery().deliver('codex', project, [server('devia-kanban'), server(CG)]);
    expect(read('.codex/config.toml')).toContain(`[mcp_servers.${CG}]`);
    delivery().deliver('codex', project, [server('devia-kanban')]);
    expect(read('.codex/config.toml')).not.toContain(CG);
    expect(read('.codex/config.toml')).toContain('[mcp_servers.devia-kanban]');
  });

  it('a no-graph run removes the markerless Gemini entry (Devia owns the bundled id)', () => {
    delivery().deliver('gemini', project, [server('devia-kanban'), server(CG)]);
    expect(Object.keys(json('.gemini/settings.json'))).toContain(CG);
    delivery().deliver('gemini', project, [server('devia-kanban')]);
    expect(Object.keys(json('.gemini/settings.json'))).toEqual(['devia-kanban']);
  });

  it('keeps a hand-added same-named entry WITHOUT the marker (marker JSON and TOML)', () => {
    fs.writeFileSync(path.join(project, 'opencode.json'), JSON.stringify({ mcp: { [CG]: { type: 'local', command: ['mine'] } } }));
    delivery().deliver('opencode', project, [server('devia-kanban')]);
    expect(json('opencode.json', 'mcp')[CG]).toEqual({ type: 'local', command: ['mine'] });

    fs.mkdirSync(path.join(project, '.codex'), { recursive: true });
    const hand = `[mcp_servers.${CG}]\ncommand = "mine"\n`;
    fs.writeFileSync(path.join(project, '.codex', 'config.toml'), hand);
    delivery().deliver('codex', project, [server('devia-kanban')]);
    expect(read('.codex/config.toml').startsWith(hand)).toBe(true);
  });

  it("Grok's GLOBAL file: a graph run in project A, then a no-graph run in B, leaves no entry", () => {
    const projectB = fs.mkdtempSync(path.join(os.tmpdir(), 'devia-native-mcp-b-'));
    try {
      const grokServers = (): Array<{ id: string; args: string[] }> =>
        JSON.parse(fs.readFileSync(path.join(home, '.grok', 'user-settings.json'), 'utf8')).mcp.servers;
      delivery().deliver('grok', project, [server('devia-kanban'), { ...server(CG), args: ['cg.js', '--project', project] }]);
      expect(grokServers().map((s) => s.id)).toContain(CG);
      delivery().deliver('grok', projectB, [server('devia-kanban')]);
      expect(grokServers().map((s) => s.id)).toEqual(['devia-kanban']);
    } finally {
      fs.rmSync(projectB, { recursive: true, force: true });
    }
  });

  it('a no-graph run on a file that never held the entry is byte-identical to the pre-graph delivery', () => {
    const seeds: Record<string, [string, string]> = {
      opencode: ['opencode.json', JSON.stringify({ mcp: { github: { type: 'local', command: ['gh'] } }, theme: 'x' })],
      'cursor-agent': ['.cursor/mcp.json', JSON.stringify({ mcpServers: { github: { command: 'gh', args: [] } } })],
      gemini: ['.gemini/settings.json', JSON.stringify({ mcpServers: { github: { command: 'gh', args: [] } }, ui: { theme: 'x' } })],
      codex: ['.codex/config.toml', 'model = "o3"\n\n[mcp_servers.github]\ncommand = "gh"\n'],
    };
    const servers = [server('devia-kanban'), server('devia-memory'), server('devia-ui')];
    const baselineDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devia-native-mcp-base-'));
    try {
      for (const [agent, [rel, body]] of Object.entries(seeds)) {
        for (const dir of [project, baselineDir]) {
          fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
          fs.writeFileSync(path.join(dir, rel), body);
        }
        delivery().deliver(agent, project, servers);
        // Baseline: what the delivery wrote before the code-graph cleanup existed.
        const target = resolveAgentTarget(agent as 'opencode', 'project', { home, project: baselineDir });
        if (!target) throw new Error(`no target for ${agent}`);
        new McpSyncWriter().write({ agent: agent as 'opencode', target, managed: servers, removedIds: ['devia-ask'], parentEnv: process.env, prune: false });
        expect(read(rel)).toBe(fs.readFileSync(path.join(baselineDir, rel), 'utf8'));
      }
      // Grok (global file).
      const grokFile = path.join(home, '.grok', 'user-settings.json');
      const grokSeed = JSON.stringify({ mcp: { servers: [{ id: 'github', command: 'gh' }] }, model: 'grok-4' });
      fs.mkdirSync(path.dirname(grokFile), { recursive: true });
      fs.writeFileSync(grokFile, grokSeed);
      delivery().deliver('grok', project, servers);
      const after = fs.readFileSync(grokFile, 'utf8');
      fs.writeFileSync(grokFile, grokSeed);
      const target = resolveAgentTarget('grok', 'project', { home, project });
      if (!target) throw new Error('no grok target');
      new McpSyncWriter().write({ agent: 'grok', target, managed: servers, removedIds: ['devia-ask'], parentEnv: process.env, prune: false });
      expect(after).toBe(fs.readFileSync(grokFile, 'utf8'));
    } finally {
      fs.rmSync(baselineDir, { recursive: true, force: true });
    }
  });

  it('a run that carries the graph keeps it (no self-removal)', () => {
    delivery().deliver('opencode', project, [server(CG)]);
    delivery().deliver('opencode', project, [server(CG)]);
    expect(Object.keys(readMcp())).toEqual([CG]);
  });
});
