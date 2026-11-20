import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { McpServerRegistry } from '../domain/registry';
import { McpSyncWriter } from '../infrastructure/mcp-sync-writer';
import { InstallMcpUseCase } from './install-mcp.use-case';
import { SetMcpExposureUseCase } from './set-mcp-exposure.use-case';

describe('SetMcpExposureUseCase', () => {
  let home: string;
  let deviaDir: string;
  let originalHome: string | undefined;
  let originalProfile: string | undefined;
  let registry: McpServerRegistry;
  let install: InstallMcpUseCase;
  let setExposure: SetMcpExposureUseCase;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'devia-exp-home-'));
    deviaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devia-exp-devia-'));
    originalHome = process.env['HOME'];
    originalProfile = process.env['USERPROFILE'];
    process.env['HOME'] = home;
    process.env['USERPROFILE'] = home;
    registry = new McpServerRegistry();
    install = new InstallMcpUseCase(registry, new McpSyncWriter(), () => deviaDir);
    setExposure = new SetMcpExposureUseCase(registry, install);
  });
  afterEach(() => {
    if (originalHome !== undefined) process.env['HOME'] = originalHome;
    else delete process.env['HOME'];
    if (originalProfile !== undefined) process.env['USERPROFILE'] = originalProfile;
    else delete process.env['USERPROFILE'];
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(deviaDir, { recursive: true, force: true });
  });

  const installTiendas = (over: Record<string, unknown> = {}) =>
    install.execute({
      id: 'tiendas', name: 'Tiendas', command: 'npx', args: ['-y', '@x/tiendas'],
      env: { API_TOKEN: 'secret-value' }, allowedEnvKeys: ['EXTRA'],
      agents: ['gemini'], scope: 'global', source: 'npm', ...over,
    });
  const gemini = (): string => {
    const f = path.join(home, '.gemini', 'settings.json');
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
  };

  it('moves a server to code mode: registry flag set, native entry removed', () => {
    installTiendas();
    expect(gemini()).toContain('tiendas');
    const result = setExposure.execute('tiendas', 'codemode');
    expect(result.ok).toBe(true);
    expect(registry.get('tiendas')?.exposure).toBe('codemode');
    expect(gemini()).not.toContain('tiendas');
  });

  it('brings it back to direct: native entry written again', () => {
    installTiendas({ exposure: 'codemode' });
    expect(gemini()).not.toContain('tiendas');
    expect(setExposure.execute('tiendas', 'direct').ok).toBe(true);
    expect(registry.get('tiendas')?.exposure).toBe('direct');
    expect(gemini()).toContain('tiendas');
  });

  it('keeps the credentials and everything else of the server', () => {
    installTiendas();
    setExposure.execute('tiendas', 'codemode');
    const kept = registry.get('tiendas');
    expect(kept?.env).toEqual({ API_TOKEN: 'secret-value' });
    expect(kept?.allowedEnvKeys).toEqual(['EXTRA']);
    expect(kept?.agents).toEqual(['gemini']);
    expect(kept?.args).toEqual(['-y', '@x/tiendas']);
    const sot = JSON.parse(fs.readFileSync(path.join(deviaDir, 'mcp-servers.json'), 'utf8')) as { servers: { env?: unknown }[] };
    expect(sot.servers[0]?.env).toEqual({ API_TOKEN: 'secret-value' });
  });

  it('refuses an unknown server', () => {
    const r = setExposure.execute('nope', 'codemode');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('nope');
  });

  it('needs the project path for a project-scoped server', () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'devia-exp-proj-'));
    try {
      installTiendas({ scope: 'project', projectPath: project });
      expect(setExposure.execute('tiendas', 'codemode').ok).toBe(false);
      expect(setExposure.execute('tiendas', 'codemode', project).ok).toBe(true);
      expect(registry.get('tiendas')?.exposure).toBe('codemode');
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });
});
