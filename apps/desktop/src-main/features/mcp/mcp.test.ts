/**
 * REV-AGENT-CORE-004: tests for the MCP server validator, registry, loader,
 * and temp-config writer.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { validateServerConfig } from './domain/validate';
import { McpServerRegistry } from './domain/registry';
import { loadMcpServers } from './infrastructure/loader';
import { writeTempMcpConfig, composeServerEnv } from './infrastructure/temp-config-writer';
import { McpConfigWatcher } from './infrastructure/mcp-config-watcher';
import { buildMcpFeature, sweepStaleMcpTempFiles } from './index';
import { createMcpProbeInvocation } from './application/probe-mcp.use-case';
import { clearPathResolverCache } from '../cli-adapters/infrastructure/detection/path-resolver';
import type { McpServerConfig } from '../../../shared/domain/mcp';
import type { FeatureContext } from '../../shared/feature';

function expectPresent<T>(value: T | null | undefined): T {
  expect(value).toBeDefined();
  return value as T;
}

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devia-mcp-')); });
afterEach(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* swallow */ }
});

describe('validateServerConfig', () => {
  const good: McpServerConfig = {
    id: 'github',
    name: 'GitHub MCP',
    command: 'github-mcp-server',
    args: ['serve'],
    enabled: true,
  };

  it('accepts a minimal valid config', () => {
    expect(validateServerConfig(good)).toEqual(good);
  });

  it('rejects when id, name, or command is missing', () => {
    expect(validateServerConfig({ ...good, id: '' })).toBeNull();
    expect(validateServerConfig({ ...good, name: '   ' })).toBeNull();
    expect(validateServerConfig({ ...good, command: undefined as unknown as string })).toBeNull();
  });

  it('accepts PATH command names and absolute executable paths', () => {
    expect(validateServerConfig({ ...good, command: 'github-mcp-server' })?.command)
      .toBe('github-mcp-server');
    expect(validateServerConfig({ ...good, command: 'G:\\OpenDesign\\OpenDesign.exe' })?.command)
      .toBe('G:\\OpenDesign\\OpenDesign.exe');
    expect(validateServerConfig({ ...good, command: 'C:\\Program Files\\OpenDesign\\OpenDesign.exe' })?.command)
      .toBe('C:\\Program Files\\OpenDesign\\OpenDesign.exe');
    expect(validateServerConfig({ ...good, command: '/usr/bin/opendesign' })?.command)
      .toBe('/usr/bin/opendesign');
  });

  it('rejects relative paths, shell syntax, and non-path whitespace commands', () => {
    expect(validateServerConfig({ ...good, command: '.\\OpenDesign.exe' })).toBeNull();
    expect(validateServerConfig({ ...good, command: 'bin/opendesign' })).toBeNull();
    expect(validateServerConfig({ ...good, command: 'a b' })).toBeNull();
    expect(validateServerConfig({ ...good, command: 'evil | rm -rf' })).toBeNull();
  });

  it('rejects non-string args', () => {
    expect(validateServerConfig({ ...good, args: [42 as unknown as string] })).toBeNull();
  });

  it('rejects allowedEnvKeys with non-uppercase keys', () => {
    const result = validateServerConfig({ ...good, allowedEnvKeys: ['Token', 'GITHUB_TOKEN'] });
    expect(result?.allowedEnvKeys).toEqual(['GITHUB_TOKEN']); // 'Token' silently dropped
  });

  it('drops the env object when all values are non-strings', () => {
    expect(validateServerConfig({ ...good, env: { X: 42 as unknown as string } })).toBeNull();
  });
});

describe('McpServerRegistry', () => {
  it('list() returns view summaries without env values', () => {
    const r = new McpServerRegistry([
      { id: 'a', name: 'A', command: 'a-cmd', args: [], enabled: true, env: { SECRET: 'x' } },
    ]);
    const view = expectPresent(r.list()[0]);
    expect(view.id).toBe('a');
    expect('env' in view).toBe(false);
  });

  it('enabled() filters by enabled and optional allowlist', () => {
    const r = new McpServerRegistry([
      { id: 'a', name: 'A', command: 'a', args: [], enabled: true },
      { id: 'b', name: 'B', command: 'b', args: [], enabled: false },
      { id: 'c', name: 'C', command: 'c', args: [], enabled: true },
    ]);
    expect(r.enabled().map(s => s.id)).toEqual(['a', 'c']);
    expect(r.enabled(['a']).map(s => s.id)).toEqual(['a']);
    expect(r.enabled(['b']).map(s => s.id)).toEqual([]);   // b is disabled
  });
});

describe('loadMcpServers', () => {
  it('returns [] when the file does not exist', () => {
    expect(loadMcpServers(tmp)).toEqual([]);
  });

  it('returns [] when JSON is malformed', () => {
    fs.writeFileSync(path.join(tmp, 'mcp-servers.json'), '{ not json', 'utf-8');
    expect(loadMcpServers(tmp)).toEqual([]);
  });

  it('drops invalid entries silently', () => {
    fs.writeFileSync(path.join(tmp, 'mcp-servers.json'), JSON.stringify({
      servers: [
        { id: 'ok', name: 'OK', command: 'ok-cmd', args: [], enabled: true },
        { id: 'bad', name: 'BAD', command: './relative/path', args: [], enabled: true },
        'not-an-object',
      ],
    }), 'utf-8');
    const result = loadMcpServers(tmp);
    expect(result.map(s => s.id)).toEqual(['ok']);
  });
});

describe('composeServerEnv', () => {
  it('only propagates env keys in allowedEnvKeys', () => {
    const env = composeServerEnv(
      { id: 'a', name: 'A', command: 'a', args: [], enabled: true, allowedEnvKeys: ['GITHUB_TOKEN'] },
      { PATH: '/usr/bin', HOME: '/home/u', GITHUB_TOKEN: 'gh_xxx' },
    );
    expect(env).toEqual({ GITHUB_TOKEN: 'gh_xxx' });
    expect(env['PATH']).toBeUndefined();
    expect(env['HOME']).toBeUndefined();
  });

  it('static env overrides parent values for the same key', () => {
    const env = composeServerEnv(
      {
        id: 'a', name: 'A', command: 'a', args: [], enabled: true,
        env: { GITHUB_TOKEN: 'override' },
        allowedEnvKeys: ['GITHUB_TOKEN'],
      },
      { GITHUB_TOKEN: 'parent' },
    );
    expect(env['GITHUB_TOKEN']).toBe('override');
  });
});

describe('createMcpProbeInvocation', () => {
  it('resolves PATH commands and wraps Windows command shims for probing', () => {
    const command = 'devia-mcp-probe-test';
    const file = process.platform === 'win32'
      ? path.join(tmp, `${command}.cmd`)
      : path.join(tmp, command);
    fs.writeFileSync(
      file,
      process.platform === 'win32' ? '@echo off\r\nexit /b 0\r\n' : '#!/bin/sh\nexit 0\n',
      'utf-8',
    );
    if (process.platform !== 'win32') fs.chmodSync(file, 0o755);

    const originalPath = process.env['PATH'];
    const originalPathext = process.env['PATHEXT'];
    try {
      process.env['PATH'] = originalPath ? `${tmp}${path.delimiter}${originalPath}` : tmp;
      if (process.platform === 'win32') process.env['PATHEXT'] = '.CMD;.EXE;.BAT';
      clearPathResolverCache();

      const invocation = createMcpProbeInvocation(
        { id: 'probe', name: 'Probe', command, args: ['--ok'], enabled: true },
        {},
      );

      if (process.platform === 'win32') {
        expect(invocation.windowsVerbatimArguments).toBe(true);
        expect(invocation.command.toLowerCase()).toContain('cmd');
        expect(invocation.args.join(' ')).toContain(`${command}.CMD`);
      } else {
        expect(invocation).toEqual({
          command: file,
          args: ['--ok'],
          windowsVerbatimArguments: false,
        });
      }
    } finally {
      if (originalPath === undefined) delete process.env['PATH'];
      else process.env['PATH'] = originalPath;
      if (originalPathext === undefined) delete process.env['PATHEXT'];
      else process.env['PATHEXT'] = originalPathext;
      clearPathResolverCache();
    }
  });
});

describe('writeTempMcpConfig', () => {
  it('returns null for an empty enabled list', () => {
    const result = writeTempMcpConfig([], tmp, {});
    expect(result).toBeNull();
  });

  it('writes a Claude-compatible JSON config and returns a cleanup hook', () => {
    const result = writeTempMcpConfig(
      [{ id: 'gh', name: 'GitHub', command: 'github-mcp', args: ['serve'], enabled: true }],
      tmp,
      {},
    );
    expect(result).not.toBeNull();
    const tempConfig = expectPresent(result);
    const raw = fs.readFileSync(tempConfig.path, 'utf-8');
    const parsed = JSON.parse(raw) as { mcpServers: Record<string, { command: string; args: string[] }> };
    expect(parsed.mcpServers['gh']).toEqual({ command: 'github-mcp', args: ['serve'] });
    tempConfig.cleanup();
    expect(fs.existsSync(tempConfig.path)).toBe(false);
  });

  it('cleanup is idempotent — second call is a no-op', () => {
    const result = writeTempMcpConfig(
      [{ id: 'a', name: 'A', command: 'a-cmd', args: [], enabled: true }],
      tmp,
      {},
    );
    const tempConfig = expectPresent(result);
    tempConfig.cleanup();
    expect(() => tempConfig.cleanup()).not.toThrow();
  });
});

// ── Startup race — registry must be populated at register(), not onReady ─────

describe('buildMcpFeature lifecycle', () => {
  function recordingCtx() {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const sends: Array<{ channel: string; payload: unknown }> = [];
    const ctx = {
      ipc: {
        handle: (channel: string, fn: (...args: unknown[]) => unknown) => { handlers.set(channel, fn); },
      },
      send: (channel: string, payload: unknown) => { sends.push({ channel, payload }); },
      getMainWindow: () => null,
    } as unknown as FeatureContext;
    return { ctx, handlers, sends };
  }

  function writeServers(ids: string[]): void {
    fs.writeFileSync(
      path.join(tmp, 'mcp-servers.json'),
      JSON.stringify({
        servers: ids.map((id) => ({ id, name: id, command: 'npx', args: [], enabled: true })),
      }),
      'utf-8',
    );
  }

  it('register() loads the registry from disk synchronously — no onReady needed', () => {
    writeServers(['context7']);

    const built = buildMcpFeature({ deviaDir: () => tmp });
    expect(built.registry.list()).toEqual([]); // not loaded yet

    // register() runs in the composition root before the window loads, so the
    // right-rail's first `mcp:list` sees a populated registry. Deferring this
    // to onReady (fired 1.5s after did-finish-load) raced the badge to 0 when
    // launching with a pinned project.
    built.feature.register(recordingCtx().ctx);
    try {
      expect(built.registry.list().map((s) => s.id)).toEqual(['context7']);
    } finally {
      built.feature.onBeforeQuit?.(); // tear down the #274 watcher
    }
  });

  it('mcp:rescan re-reads the file so external edits are picked up (#274)', () => {
    writeServers(['context7']);
    const built = buildMcpFeature({ deviaDir: () => tmp });
    const { ctx, handlers } = recordingCtx();
    built.feature.register(ctx);
    try {
      // Edited out-of-process while Devia is running.
      writeServers(['context7', 'github']);
      const rescan = expectPresent(handlers.get('mcp:rescan'));
      const result = rescan() as Array<{ id: string }>;
      expect(result.map((s) => s.id)).toEqual(['context7', 'github']);
      expect(built.registry.list().map((s) => s.id)).toEqual(['context7', 'github']);
    } finally {
      built.feature.onBeforeQuit?.();
    }
  });
});

// ── #274 — live refresh on out-of-process edits to mcp-servers.json ──────────

describe('McpConfigWatcher', () => {
  const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  it('fires onChange (debounced) when the watched file is written', async () => {
    const file = path.join(tmp, 'mcp-servers.json');
    fs.writeFileSync(file, JSON.stringify({ servers: [] }), 'utf-8');

    let fired = 0;
    const watcher = new McpConfigWatcher(() => file, () => { fired++; });
    watcher.start();
    try {
      await delay(50); // let the OS watch attach
      fs.writeFileSync(
        file,
        JSON.stringify({ servers: [{ id: 'x', name: 'X', command: 'x', args: [], enabled: true }] }),
        'utf-8',
      );
      for (let i = 0; i < 60 && fired === 0; i++) {
        if (i === 10) fs.appendFileSync(file, '\n'); // nudge in case the first event was missed
        await delay(50);
      }
      expect(fired).toBeGreaterThan(0);
    } finally {
      watcher.stop();
    }
  });

  it('start() and stop() are idempotent and never throw', () => {
    const watcher = new McpConfigWatcher(() => path.join(tmp, 'mcp-servers.json'), () => undefined);
    watcher.start();
    expect(() => watcher.start()).not.toThrow();
    expect(() => watcher.stop()).not.toThrow();
    expect(() => watcher.stop()).not.toThrow();
  });
});

// ── UC-FIX-015 — stale temp-file sweep ───────────────────────────────────────

describe('sweepStaleMcpTempFiles', () => {
  function plantFile(deviaDir: string, name: string, ageMs: number): string {
    const tmpDir = path.join(deviaDir, 'tmp');
    fs.mkdirSync(tmpDir, { recursive: true });
    const filePath = path.join(tmpDir, name);
    fs.writeFileSync(filePath, '{}');
    const mtime = new Date(Date.now() - ageMs);
    fs.utimesSync(filePath, mtime, mtime);
    return filePath;
  }

  it('AC1: removes temp files older than the threshold', () => {
    const old = plantFile(tmp, 'mcp-old-uuid.json', 25 * 60 * 60 * 1000); // 25 h
    sweepStaleMcpTempFiles(tmp, 24 * 60 * 60 * 1000);
    expect(fs.existsSync(old)).toBe(false);
  });

  it('AC2: keeps temp files newer than the threshold', () => {
    const fresh = plantFile(tmp, 'mcp-fresh-uuid.json', 60 * 1000); // 1 min
    sweepStaleMcpTempFiles(tmp, 24 * 60 * 60 * 1000);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it('AC3: does not crash when tmpDir does not exist', () => {
    expect(() => sweepStaleMcpTempFiles(path.join(tmp, 'nonexistent'))).not.toThrow();
  });

  it('ignores files that do not match mcp-*.json pattern', () => {
    const other = plantFile(tmp, 'other-config.json', 48 * 60 * 60 * 1000); // 48 h
    sweepStaleMcpTempFiles(tmp, 24 * 60 * 60 * 1000);
    expect(fs.existsSync(other)).toBe(true); // not deleted
  });
});
