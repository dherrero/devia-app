import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { KanbanMcpInjector } from './kanban-mcp-injector';

const injector = new KanbanMcpInjector(() => '/home/u/.devia-app');

describe('KanbanMcpInjector.serverConfig', () => {
  it('spawns the compiled stdio server through the Electron binary in Node mode', () => {
    const config = injector.serverConfig('/ws/proj');
    expect(config.id).toBe('devia-kanban');
    expect(config.command).toBe(process.execPath);
    expect(path.basename(config.args[0] ?? '')).toBe('server.js');
    expect(config.env).toEqual({ ELECTRON_RUN_AS_NODE: '1' });
  });

  it('keys the board by the project identity it is given (the base checkout)', () => {
    expect(injector.serverConfig('/ws/proj').args.slice(1)).toEqual(['--devia-dir', '/home/u/.devia-app', '--project', '/ws/proj']);
  });

  it('carries the codex TOML tuning and pi exposure hints', () => {
    expect(injector.serverConfig('/ws/proj')).toMatchObject({ startupTimeoutSec: 30, defaultToolsApprovalMode: 'auto', exposure: 'direct' });
  });
});
