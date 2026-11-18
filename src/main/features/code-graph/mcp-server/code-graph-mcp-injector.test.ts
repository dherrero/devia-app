import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { ConfigRepository } from '../../../shared/ports';
import { CodeGraphStore } from '../infrastructure/code-graph-store';
import { buildCodeGraphFeature } from '../index';
import { CODE_GRAPH_SERVER_ID, CodeGraphMcpInjector } from './code-graph-mcp-injector';

const injector = new CodeGraphMcpInjector(() => '/home/u/.devia-app');

describe('CodeGraphMcpInjector.serverConfig', () => {
  it('spawns the compiled stdio server through the Electron binary in Node mode', () => {
    const config = injector.serverConfig('/ws/proj');
    expect(config.id).toBe('devia-code-graph');
    expect(CODE_GRAPH_SERVER_ID).toBe('devia-code-graph');
    expect(config.name).toBe('Devia Code Graph');
    expect(config.command).toBe(process.execPath);
    expect(config.args[0]).toBe(path.join(__dirname, 'server.js'));
    expect(config.env).toEqual({ ELECTRON_RUN_AS_NODE: '1' });
    expect(config.enabled).toBe(true);
  });

  it('binds the server to the devia dir and the project it is given', () => {
    expect(injector.serverConfig('/ws/proj').args.slice(1)).toEqual(['--devia-dir', '/home/u/.devia-app', '--project', '/ws/proj']);
  });

  it('carries the active agent id when given', () => {
    expect(injector.serverConfig('/ws/proj', 'codex').env).toEqual({ ELECTRON_RUN_AS_NODE: '1', DEVIA_ACTIVE_AGENT_ID: 'codex' });
  });

  it('carries the codex TOML tuning and pi exposure hints', () => {
    expect(injector.serverConfig('/ws/proj')).toMatchObject({ startupTimeoutSec: 30, defaultToolsApprovalMode: 'auto', exposure: 'direct' });
  });
});

describe('buildCodeGraphFeature().codeGraphMcpServer (gating)', () => {
  let deviaDir: string;
  let project: string;
  let worktree: string;
  let store: CodeGraphStore;

  const config = (dir: () => string = () => deviaDir): ConfigRepository => ({ deviaDir: dir }) as unknown as ConfigRepository;
  const built = () => buildCodeGraphFeature({ config: config() });
  const withGraph = (projectAbs: string, agentAccess?: false): void => {
    store.saveDoc(projectAbs, { createdAt: 1, indexedAt: 1, autoUpdate: true, ...(agentAccess === false && { agentAccess }) });
    fs.writeFileSync(store.dbPath(projectAbs), '');
  };

  beforeEach(() => {
    deviaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devia-cg-inj-'));
    project = path.join(deviaDir, 'ws', 'proj');
    worktree = path.join(deviaDir, 'worktrees', 'proj-sess');
    store = new CodeGraphStore(() => deviaDir);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(deviaDir, { recursive: true, force: true });
  });

  it('is null when the project has no graph', () => {
    expect(built().codeGraphMcpServer(project, 'claude')).toBeNull();
  });

  it('is null when only project.json exists (no graph.db)', () => {
    store.saveDoc(project, { createdAt: 1, indexedAt: 1, autoUpdate: true });
    expect(built().codeGraphMcpServer(project)).toBeNull();
  });

  it('is null when the user switched agent access off', () => {
    withGraph(project, false);
    expect(built().codeGraphMcpServer(project, 'claude')).toBeNull();
  });

  it('is the server config for a project with a graph and the default switch', () => {
    withGraph(project);
    const server = built().codeGraphMcpServer(project, 'claude');
    expect(server).toEqual(new CodeGraphMcpInjector(() => deviaDir).serverConfig(project, 'claude'));
  });

  it('looks up the exact path it is given: a worktree without its own graph gets nothing, even if the base has one', () => {
    withGraph(project);
    expect(built().codeGraphMcpServer(worktree, 'claude')).toBeNull();
    withGraph(worktree);
    expect(built().codeGraphMcpServer(worktree, 'claude')?.args.slice(-2)).toEqual(['--project', worktree]);
  });

  it('never throws: a store failure yields null and a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const broken = buildCodeGraphFeature({ config: config(() => { throw new Error('boom'); }) });
    expect(broken.codeGraphMcpServer(project, 'claude')).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[code-graph]'), 'boom');
  });
});
