import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { McpServerConfig } from '../../../../shared/domain/mcp';
import { buildPiMcpExtensionSource, retirePiProjectMcp, writePiMcpExtension } from './pi-mcp-extension';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devia-pi-ext-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function server(id: string, extra: Partial<McpServerConfig> = {}): McpServerConfig {
  return { id, name: id, command: '/bin/node', args: ['server.js', '--x'], env: { ELECTRON_RUN_AS_NODE: '1' }, enabled: true, ...extra };
}

describe('writePiMcpExtension', () => {
  it('returns null when there is nothing to register', () => {
    expect(writePiMcpExtension([], dir, {})).toBeNull();
  });

  it('writes a loadable extension that registers every server as direct', async () => {
    const ext = writePiMcpExtension([server('devia-kanban'), server('devia-ui', { exposure: 'direct' })], dir, {});
    expect(ext).not.toBeNull();
    expect(ext!.path.startsWith(path.join(dir, 'tmp'))).toBe(true);
    const mod = (await import(pathToFileURL(ext!.path).href)) as { default: (pi: unknown) => void };
    const registered: Array<[string, Record<string, unknown>]> = [];
    mod.default({ registerMcpServer: (n: string, c: Record<string, unknown>) => registered.push([n, c]) });
    expect(registered.map(([n]) => n)).toEqual(['devia-kanban', 'devia-ui']);
    expect(registered[0]![1]).toMatchObject({ command: '/bin/node', args: ['server.js', '--x'], env: { ELECTRON_RUN_AS_NODE: '1' }, exposure: 'direct' });
    // Blocking UI tools outlive pi's default 60 s MCP request timeout.
    expect(registered[1]![1]['timeout']).toBe(360);
    expect(registered[0]![1]['timeout']).toBeUndefined();
    ext!.cleanup();
    expect(fs.existsSync(ext!.path)).toBe(false);
  });

  it('only forwards allow-listed parent env keys', () => {
    const src = buildPiMcpExtensionSource([server('s', { allowedEnvKeys: ['TOKEN'] })], { TOKEN: 't', SECRET: 'nope' });
    expect(src).toContain('"TOKEN": "t"');
    expect(src).not.toContain('nope');
  });
});

describe('retirePiProjectMcp', () => {
  const file = (): string => path.join(dir, '.pi', 'mcp.json');
  const write = (v: unknown): void => {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(v));
  };

  it('deletes a file that only held Devia entries', () => {
    write({ mcpServers: { 'devia-kanban': { command: 'x', __devia_managed: 'devia-kanban' }, 'devia-ui': { command: 'y', __devia_managed: 'devia-ui' } } });
    retirePiProjectMcp(dir);
    expect(fs.existsSync(file())).toBe(false);
  });

  it('keeps hand-added servers, including one that reuses a Devia id without the marker', () => {
    write({ mcpServers: { 'devia-kanban': { command: 'x', __devia_managed: 'devia-kanban' }, 'devia-memory': { command: 'mine' }, github: { command: 'gh' } } });
    retirePiProjectMcp(dir);
    const servers = JSON.parse(fs.readFileSync(file(), 'utf8')).mcpServers as Record<string, unknown>;
    expect(Object.keys(servers).sort()).toEqual(['devia-memory', 'github']);
  });

  it('leaves the file untouched when it holds nothing of ours, and tolerates a missing file', () => {
    write({ mcpServers: { github: { command: 'gh' } } });
    const before = fs.readFileSync(file(), 'utf8');
    retirePiProjectMcp(dir);
    expect(fs.readFileSync(file(), 'utf8')).toBe(before);
    expect(() => retirePiProjectMcp(path.join(dir, 'missing'))).not.toThrow();
  });
});
