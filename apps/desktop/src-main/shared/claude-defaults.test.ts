import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { grantClaudeMcpAccess, removeDeviaAskUserQuestionHook, revokeClaudeMcpAccess } from './claude-defaults';

const SETTINGS_REL = path.join('.claude', 'settings.local.json');

describe('grantClaudeMcpAccess / revokeClaudeMcpAccess', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devia-claude-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const settingsPath = (): string => path.join(dir, SETTINGS_REL);
  const read = (): Record<string, unknown> =>
    JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) as Record<string, unknown>;

  it('creates the file with the mcp allow entry and gitignores it', () => {
    grantClaudeMcpAccess(dir, ['devia-kanban']);

    const settings = read() as { permissions?: { allow?: string[] } };
    expect(settings.permissions?.allow).toContain('mcp__devia-kanban');

    const gitignore = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
    expect(gitignore).toContain('.claude/settings.local.json');
  });

  it('merges into an existing file, preserving unrelated keys', () => {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify({
      permissions: { allow: ['Bash(git status)'], deny: ['Bash(rm -rf*)'] },
      model: 'opus',
    }));

    grantClaudeMcpAccess(dir, ['my-server']);

    const settings = read() as {
      permissions?: { allow?: string[]; deny?: string[] };
      model?: string;
    };
    expect(settings.permissions?.allow).toEqual(['Bash(git status)', 'mcp__my-server']);
    expect(settings.permissions?.deny).toEqual(['Bash(rm -rf*)']);
    expect(settings.model).toBe('opus');
  });

  it('is idempotent — no duplicate entries on repeated grants', () => {
    grantClaudeMcpAccess(dir, ['a', 'b']);
    grantClaudeMcpAccess(dir, ['a', 'b']);
    const allow = (read() as { permissions: { allow: string[] } }).permissions.allow;
    expect(allow.filter((e) => e === 'mcp__a')).toHaveLength(1);
    expect(allow.filter((e) => e === 'mcp__b')).toHaveLength(1);
  });

  it('treats the whole-server wildcard form as already covering the server', () => {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify({
      permissions: { allow: ['mcp__leantime__*'] },
    }));

    grantClaudeMcpAccess(dir, ['leantime']);

    const allow = (read() as { permissions: { allow: string[] } }).permissions.allow;
    expect(allow).toEqual(['mcp__leantime__*']);
  });

  it('adds enabledMcpjsonServers when trustProjectMcpjson is set', () => {
    grantClaudeMcpAccess(dir, ['proj-srv'], { trustProjectMcpjson: true });

    const settings = read() as { enabledMcpjsonServers?: string[]; permissions?: { allow?: string[] } };
    expect(settings.enabledMcpjsonServers).toContain('proj-srv');
    expect(settings.permissions?.allow).toContain('mcp__proj-srv');
  });

  it('skips enabledMcpjsonServers when enableAllProjectMcpServers is already true', () => {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify({ enableAllProjectMcpServers: true }));

    grantClaudeMcpAccess(dir, ['proj-srv'], { trustProjectMcpjson: true });

    const settings = read() as { enabledMcpjsonServers?: string[] };
    expect(settings.enabledMcpjsonServers).toBeUndefined();
  });

  it('leaves a malformed settings file untouched', () => {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), '{ this is not json');

    grantClaudeMcpAccess(dir, ['x']);

    expect(fs.readFileSync(settingsPath(), 'utf8')).toBe('{ this is not json');
  });

  it('does nothing for an empty id list', () => {
    grantClaudeMcpAccess(dir, []);
    expect(fs.existsSync(settingsPath())).toBe(false);
  });

  it('revoke strips the allow entry and the enabledMcpjsonServers id', () => {
    grantClaudeMcpAccess(dir, ['a', 'b'], { trustProjectMcpjson: true });
    revokeClaudeMcpAccess(dir, ['a']);

    const settings = read() as {
      permissions: { allow: string[] };
      enabledMcpjsonServers: string[];
    };
    expect(settings.permissions.allow).not.toContain('mcp__a');
    expect(settings.permissions.allow).toContain('mcp__b');
    expect(settings.enabledMcpjsonServers).not.toContain('a');
    expect(settings.enabledMcpjsonServers).toContain('b');
  });

  it('revoke removes the wildcard allow form too', () => {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify({
      permissions: { allow: ['mcp__leantime__*', 'Read(*)'] },
    }));

    revokeClaudeMcpAccess(dir, ['leantime']);

    const allow = (read() as { permissions: { allow: string[] } }).permissions.allow;
    expect(allow).toEqual(['Read(*)']);
  });

  it('revoke is a no-op when the file is absent', () => {
    expect(() => revokeClaudeMcpAccess(dir, ['x'])).not.toThrow();
    expect(fs.existsSync(settingsPath())).toBe(false);
  });

});

// ── S-24 — sweeping the retired AskUserQuestion PreToolUse hook ─────────────
// Devia wrote this hook into every project it ran in. Claude Code 2.1.220
// removed the tool from headless runs, so the entry can never fire and points
// at a script that no longer ships. It has to be cleaned, not just stopped.

describe('removeDeviaAskUserQuestionHook', () => {
  let dir: string;
  const settingsPath = (): string => path.join(dir, '.claude', 'settings.local.json');
  const read = (): unknown => JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) as unknown;
  const hookScript = path.join('G:', 'devia', 'dist', 'ask-user-question-hook.js');

  function writeSettings(value: unknown): void {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(value));
  }

  function deviaHook(): unknown {
    return {
      type: 'command',
      command: `ELECTRON_RUN_AS_NODE=1 ${JSON.stringify(process.execPath)} ${JSON.stringify(hookScript)}`,
      timeout: 330,
    };
  }

  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devia-hook-sweep-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('drops the whole group when it only held the Devia hook', () => {
    writeSettings({
      permissions: { allow: ['mcp__devia-kanban'] },
      hooks: { PreToolUse: [{ matcher: 'AskUserQuestion', hooks: [deviaHook()] }] },
    });

    removeDeviaAskUserQuestionHook(dir);

    const settings = read() as { hooks?: unknown; permissions?: { allow: string[] } };
    expect(settings.hooks).toBeUndefined();
    expect(settings.permissions?.allow).toEqual(['mcp__devia-kanban']);
  });

  it('also sweeps the legacy bare-`node` form', () => {
    writeSettings({
      hooks: {
        PreToolUse: [{
          matcher: 'AskUserQuestion',
          hooks: [{ type: 'command', command: `node ${JSON.stringify(hookScript)}` }],
        }],
      },
    });

    removeDeviaAskUserQuestionHook(dir);

    expect((read() as { hooks?: unknown }).hooks).toBeUndefined();
  });

  it('keeps a hook the user added under the same matcher', () => {
    const mine = { type: 'command', command: 'my-own-script.sh' };
    writeSettings({
      hooks: { PreToolUse: [{ matcher: 'AskUserQuestion', hooks: [deviaHook(), mine] }] },
    });

    removeDeviaAskUserQuestionHook(dir);

    const groups = (read() as { hooks: { PreToolUse: Array<{ hooks: unknown[] }> } }).hooks.PreToolUse;
    expect(groups).toHaveLength(1);
    expect(groups[0]?.hooks).toEqual([mine]);
  });

  it('never touches groups for other matchers', () => {
    const other = { matcher: 'Bash', hooks: [{ type: 'command', command: 'audit.sh' }] };
    writeSettings({
      hooks: { PreToolUse: [{ matcher: 'AskUserQuestion', hooks: [deviaHook()] }, other] },
    });

    removeDeviaAskUserQuestionHook(dir);

    const groups = (read() as { hooks: { PreToolUse: unknown[] } }).hooks.PreToolUse;
    expect(groups).toEqual([other]);
  });

  it('preserves other hook events while dropping an emptied PreToolUse', () => {
    const stop = [{ matcher: '*', hooks: [{ type: 'command', command: 'notify.sh' }] }];
    writeSettings({
      hooks: { PreToolUse: [{ matcher: 'AskUserQuestion', hooks: [deviaHook()] }], Stop: stop },
    });

    removeDeviaAskUserQuestionHook(dir);

    const settings = read() as { hooks: { PreToolUse?: unknown; Stop: unknown } };
    expect(settings.hooks.PreToolUse).toBeUndefined();
    expect(settings.hooks.Stop).toEqual(stop);
  });

  it('is idempotent — a second sweep rewrites nothing', () => {
    writeSettings({ hooks: { PreToolUse: [{ matcher: 'AskUserQuestion', hooks: [deviaHook()] }] } });

    removeDeviaAskUserQuestionHook(dir);
    const afterFirst = fs.statSync(settingsPath()).mtimeMs;
    removeDeviaAskUserQuestionHook(dir);

    expect(fs.statSync(settingsPath()).mtimeMs).toBe(afterFirst);
  });

  it('never creates the settings file just to clean it', () => {
    expect(() => removeDeviaAskUserQuestionHook(dir)).not.toThrow();
    expect(fs.existsSync(settingsPath())).toBe(false);
  });

  it('leaves a malformed file untouched', () => {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), 'not json');

    removeDeviaAskUserQuestionHook(dir);

    expect(fs.readFileSync(settingsPath(), 'utf8')).toBe('not json');
  });
});
