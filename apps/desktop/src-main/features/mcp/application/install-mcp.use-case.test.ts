import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { McpServerRegistry } from '../domain/registry';
import { McpSyncWriter } from '../infrastructure/mcp-sync-writer';
import { InstallMcpUseCase } from './install-mcp.use-case';
import { RemoveMcpUseCase } from './remove-mcp.use-case';
import { DEVIA_MANAGED_KEY } from '../infrastructure/marker-merge';

/**
 * End-to-end test for the MCP install + remove pipeline.
 *
 * Routes the writes through a temp HOME so we can assert the agent
 * files materialise without touching the real user config.
 */

function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'devia-mcp-home-'));
  const deviaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devia-mcp-devia-'));
  const originalHome = process.env['HOME'];
  const originalUserProfile = process.env['USERPROFILE'];
  // os.homedir() reads HOME on POSIX, USERPROFILE on Windows. Set
  // both so the test is platform-agnostic.
  process.env['HOME'] = home;
  process.env['USERPROFILE'] = home;

  const registry = new McpServerRegistry();
  const writer = new McpSyncWriter();
  const install = new InstallMcpUseCase(registry, writer, () => deviaDir);
  const remove = new RemoveMcpUseCase(registry, writer, () => deviaDir);

  return {
    home,
    deviaDir,
    registry,
    install,
    remove,
    cleanup(): void {
      if (originalHome !== undefined) process.env['HOME'] = originalHome;
      else delete process.env['HOME'];
      if (originalUserProfile !== undefined) process.env['USERPROFILE'] = originalUserProfile;
      else delete process.env['USERPROFILE'];
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(deviaDir, { recursive: true, force: true });
    },
  };
}

describe('InstallMcpUseCase end-to-end', () => {
  let fx: ReturnType<typeof setup>;
  beforeEach(() => { fx = setup(); });
  afterEach(() => fx.cleanup());

  it('writes the source-of-truth file AND each selected agent file', () => {
    const result = fx.install.execute({
      id: 'alpha',
      name: 'Alpha',
      command: 'npx',
      args: ['-y', '@example/alpha'],
      agents: ['gemini', 'opencode'],
      scope: 'global',
      source: 'npm',
    });

    expect(result.ok).toBe(true);
    // Devia source of truth.
    const sotFile = path.join(fx.deviaDir, 'mcp-servers.json');
    expect(fs.existsSync(sotFile)).toBe(true);
    const sot = JSON.parse(fs.readFileSync(sotFile, 'utf8'));
    expect(sot.servers[0].id).toBe('alpha');

    // Gemini & OpenCode files both got the entry with the marker.
    const gemini = JSON.parse(fs.readFileSync(
      path.join(fx.home, '.gemini', 'settings.json'), 'utf8',
    ));
    expect(gemini.mcpServers.alpha?.[DEVIA_MANAGED_KEY]).toBe('alpha');

    const opencode = JSON.parse(fs.readFileSync(
      path.join(fx.home, '.config', 'opencode', 'opencode.json'), 'utf8',
    ));
    // OpenCode demands its McpLocalConfig shape: type:"local" + argv array.
    expect(opencode.mcp.alpha?.type).toBe('local');
    expect(opencode.mcp.alpha?.command).toEqual(['npx', '-y', '@example/alpha']);
    expect(opencode.mcp.alpha?.args).toBeUndefined();
    expect(opencode.mcp.alpha?.[DEVIA_MANAGED_KEY]).toBe('alpha');
  });

  it('respects hand-edited entries on first install', () => {
    // Pre-seed Cursor's mcp.json with a user-added server.
    const cursorFile = path.join(fx.home, '.cursor', 'mcp.json');
    fs.mkdirSync(path.dirname(cursorFile), { recursive: true });
    fs.writeFileSync(cursorFile, JSON.stringify({
      mcpServers: {
        userBuilt: { command: 'userbin', args: [] },
      },
    }), 'utf8');

    fx.install.execute({
      id: 'alpha',
      name: 'Alpha',
      command: 'npx',
      args: ['-y', '@example/alpha'],
      agents: ['cursor-agent'],
      scope: 'global',
      source: 'npm',
    });

    const after = JSON.parse(fs.readFileSync(cursorFile, 'utf8'));
    expect(after.mcpServers.userBuilt.command).toBe('userbin');
    expect(after.mcpServers.alpha[DEVIA_MANAGED_KEY]).toBe('alpha');
  });

  it('writes the Codex TOML file with start/end markers', () => {
    fx.install.execute({
      id: 'alpha',
      name: 'Alpha',
      command: 'npx',
      args: ['-y', '@example/alpha'],
      agents: ['codex'],
      scope: 'global',
      source: 'npm',
    });

    const codexFile = path.join(fx.home, '.codex', 'config.toml');
    const body = fs.readFileSync(codexFile, 'utf8');
    expect(body).toContain('# devia-mcp-start alpha');
    expect(body).toContain('[mcp_servers.alpha]');
    expect(body).toContain('# devia-mcp-end alpha');
  });

  it('writes the Claude user-scope entry into ~/.claude.json with the managed marker (T-50 of S-3)', () => {
    // Pre-seed ~/.claude.json with unrelated top-level keys to lock down
    // that the merge preserves them — this file holds the user's
    // theme/model/projects/etc. and must NEVER be overwritten wholesale.
    const claudeJson = path.join(fx.home, '.claude.json');
    fs.mkdirSync(path.dirname(claudeJson), { recursive: true });
    fs.writeFileSync(
      claudeJson,
      JSON.stringify(
        { theme: 'dark', model: 'sonnet', projects: { '/x': { mcpServers: {} } } },
        null,
        2,
      ),
      'utf8',
    );

    fx.install.execute({
      id: 'alpha',
      name: 'Alpha',
      command: 'npx',
      args: ['-y', '@example/alpha'],
      agents: ['claude'],
      scope: 'global',
      source: 'npm',
    });

    expect(fs.existsSync(claudeJson)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(claudeJson, 'utf8'));
    // Devia entry landed under top-level mcpServers.
    expect(parsed.mcpServers.alpha.__devia_managed).toBe('alpha');
    expect(parsed.mcpServers.alpha.command).toBe('npx');
    // Unrelated keys untouched.
    expect(parsed.theme).toBe('dark');
    expect(parsed.model).toBe('sonnet');
    expect(parsed.projects).toEqual({ '/x': { mcpServers: {} } });
  });
});

describe('RemoveMcpUseCase end-to-end', () => {
  let fx: ReturnType<typeof setup>;
  beforeEach(() => { fx = setup(); });
  afterEach(() => fx.cleanup());

  it('removes the entry from the source of truth + every agent file', () => {
    fx.install.execute({
      id: 'alpha',
      name: 'Alpha',
      command: 'npx',
      args: ['-y', '@example/alpha'],
      agents: ['gemini', 'codex'],
      scope: 'global',
      source: 'npm',
    });

    const result = fx.remove.execute('alpha');
    expect(result.ok).toBe(true);

    // Source of truth no longer contains alpha.
    const sot = JSON.parse(fs.readFileSync(path.join(fx.deviaDir, 'mcp-servers.json'), 'utf8'));
    expect(sot.servers.find((s: { id: string }) => s.id === 'alpha')).toBeUndefined();

    // Gemini JSON: parent key gone (only Devia entry).
    const gemini = JSON.parse(fs.readFileSync(
      path.join(fx.home, '.gemini', 'settings.json'), 'utf8',
    ));
    expect(gemini.mcpServers).toBeUndefined();

    // Codex TOML: alpha block stripped.
    const codex = fs.readFileSync(path.join(fx.home, '.codex', 'config.toml'), 'utf8');
    expect(codex).not.toContain('alpha');
  });

  it('preserves hand-edited entries when removing the Devia entry', () => {
    // Pre-seed Cursor with a user server.
    const cursorFile = path.join(fx.home, '.cursor', 'mcp.json');
    fs.mkdirSync(path.dirname(cursorFile), { recursive: true });
    fs.writeFileSync(cursorFile, JSON.stringify({
      mcpServers: { userBuilt: { command: 'userbin', args: [] } },
    }), 'utf8');

    fx.install.execute({
      id: 'alpha',
      name: 'Alpha',
      command: 'npx',
      args: ['-y', '@example/alpha'],
      agents: ['cursor-agent'],
      scope: 'global',
      source: 'npm',
    });

    fx.remove.execute('alpha');

    const after = JSON.parse(fs.readFileSync(cursorFile, 'utf8'));
    expect(after.mcpServers.userBuilt.command).toBe('userbin');
    expect(after.mcpServers.alpha).toBeUndefined();
  });
});
