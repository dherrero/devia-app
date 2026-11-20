import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { McpServerConfig } from '../../../../shared/domain/mcp';
import { CODE_MODE_SERVER_ID, CodeModeMcpInjector, codeModeRunDir } from './code-mode-mcp-injector';

function server(id: string, env?: Record<string, string>): McpServerConfig {
  return { id, name: id, command: 'node', args: ['s.js'], enabled: true, exposure: 'codemode', ...(env && { env }) };
}

describe('CodeModeMcpInjector', () => {
  let deviaDir: string;
  beforeEach(() => {
    deviaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-inj-'));
  });
  afterEach(() => fs.rmSync(deviaDir, { recursive: true, force: true }));

  const build = (servers: McpServerConfig[], over: { mode?: 'plan' | 'apply' | 'apply-yolo'; now?: () => number } = {}) =>
    new CodeModeMcpInjector(() => deviaDir, over.now).serverConfig({
      codeModeServers: servers,
      agentId: 'claude',
      mode: over.mode ?? 'apply',
      runId: 'run-1',
    });

  it('describes a stdio server run by the Electron binary as node', () => {
    const cfg = build([server('tiendas')]);
    expect(cfg.id).toBe(CODE_MODE_SERVER_ID);
    expect(cfg.command).toBe(process.execPath);
    expect(cfg.env).toMatchObject({ ELECTRON_RUN_AS_NODE: '1', DEVIA_CODE_MODE_MODE: 'apply', DEVIA_ACTIVE_AGENT_ID: 'claude' });
    expect(cfg.exposure).toBe('direct');
    expect(cfg.enabled).toBe(true);
    expect(cfg.startupTimeoutSec).toBe(30);
    expect(cfg.defaultToolsApprovalMode).toBe('auto');
  });

  it('carries the run mode so plan mode reaches the gateway', () => {
    expect(build([server('a')], { mode: 'plan' }).env?.['DEVIA_CODE_MODE_MODE']).toBe('plan');
  });

  it('writes the servers to a private file under the run dir, not into argv', () => {
    const cfg = build([server('tiendas', { API_TOKEN: 'sup3r-secret' })]);
    const idx = cfg.args.indexOf('--servers-file');
    const file = cfg.args[idx + 1] as string;
    expect(file).toBe(path.join(codeModeRunDir(deviaDir, 'run-1'), 'servers.json'));
    const written = JSON.parse(fs.readFileSync(file, 'utf8')) as { servers: McpServerConfig[] };
    expect(written.servers.map((s) => s.id)).toEqual(['tiendas']);
    expect(written.servers[0]?.env).toEqual({ API_TOKEN: 'sup3r-secret' });
    expect(JSON.stringify(cfg)).not.toContain('sup3r-secret');
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('points the gateway at the run events dir', () => {
    const cfg = build([server('a')]);
    const idx = cfg.args.indexOf('--events-dir');
    expect(cfg.args[idx + 1]).toBe(path.join(codeModeRunDir(deviaDir, 'run-1'), 'events'));
  });

  it('removes run dirs older than six hours and keeps recent ones', () => {
    const root = path.join(deviaDir, 'tmp', 'code-mode');
    const old = path.join(root, 'old-run');
    const recent = path.join(root, 'recent-run');
    fs.mkdirSync(old, { recursive: true });
    fs.mkdirSync(recent, { recursive: true });
    const now = Date.now();
    fs.utimesSync(old, new Date(now - 7 * 3600_000), new Date(now - 7 * 3600_000));
    build([server('a')]);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(recent)).toBe(true);
  });
});
