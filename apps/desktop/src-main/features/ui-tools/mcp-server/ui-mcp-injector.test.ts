import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { UiToolName } from '../../../../shared/domain/ui-tools';
import { UiMcpInjector } from './ui-mcp-injector';

const injector = new UiMcpInjector();
const UI_DIR = '/tmp/devia-ui/run-42';
const TOOLS: UiToolName[] = ['ask_user', 'todo', 'confirm'];

describe('serverConfig', () => {
  it('spawns the compiled server through the Electron binary in Node mode', () => {
    const config = injector.serverConfig(UI_DIR, TOOLS);

    expect(config.id).toBe('devia-ui');
    expect(config.command).toBe(process.execPath);
    expect(config.env).toEqual({ ELECTRON_RUN_AS_NODE: '1' });
    expect(config.enabled).toBe(true);
  });

  it('passes the per-run rendezvous directory and the advertised tool list', () => {
    const config = injector.serverConfig(UI_DIR, TOOLS);

    expect(config.args?.slice(1)).toEqual([
      '--ui-dir',
      UI_DIR,
      '--tools',
      'ask_user,todo,confirm',
    ]);
    expect(path.basename(config.args?.[0] ?? '')).toBe('server.js');
  });

  it('carries the Codex TOML tuning fields the other bundled servers use', () => {
    const config = injector.serverConfig(UI_DIR, TOOLS);

    expect(config.startupTimeoutSec).toBe(30);
    expect(config.defaultToolsApprovalMode).toBe('auto');
  });

  it('reflects a different run directory on every call', () => {
    expect(injector.serverConfig('/tmp/run-a', TOOLS).args).not.toEqual(
      injector.serverConfig('/tmp/run-b', TOOLS).args,
    );
  });
  it('passes every Devia skill root and the sub-agents dir to devia_skill (S-30 T-356)', () => {
    const config = injector.serverConfig(UI_DIR, TOOLS, { skillsDirs: ['/p/.claude/skills', '/h/skills'], subagentsDir: '/p/.devia/sub-agents' });
    expect(config.args.slice(5)).toEqual(['--skills-dir', '/p/.claude/skills', '--skills-dir', '/h/skills', '--subagents-dir', '/p/.devia/sub-agents']);
  });

  it('emits --send-roots/--cwd/--deny-roots only when send_file is advertised (S-32)', () => {
    const send = { sendRoots: ['/ws', '/ws2'], cwd: '/ws/app', denyRoots: ['/home/u/.devia-app'] };
    expect(injector.serverConfig(UI_DIR, TOOLS, send).args).toEqual(
      injector.serverConfig(UI_DIR, TOOLS).args,
    );
    const config = injector.serverConfig(UI_DIR, [...TOOLS, 'send_file'], send);
    expect(config.args.slice(5)).toEqual([
      '--send-roots',
      '["/ws","/ws2"]',
      '--cwd',
      '/ws/app',
      '--deny-roots',
      '["/home/u/.devia-app"]',
    ]);
  });

  it('omits the send argv it was not given even with send_file advertised', () => {
    expect(injector.serverConfig(UI_DIR, ['send_file']).args.slice(1)).toEqual([
      '--ui-dir',
      UI_DIR,
      '--tools',
      'send_file',
    ]);
  });
});
