import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrateLegacyMcpPaths } from './legacy-path-migration';
import { DEVIA_MANAGED_KEY } from './marker-merge';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devia-mcp-migration-')); });
afterEach(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* swallow */ }
});

const NOOP_LOG = (): void => undefined;

function writeJson(file: string, body: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(body, null, 2) + '\n', 'utf8');
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
}

describe('migrateLegacyMcpPaths — claude global', () => {
  it('moves Devia-managed entries from ~/.claude/mcp.json into ~/.claude.json (top-level mcpServers)', () => {
    writeJson(path.join(tmp, '.claude', 'mcp.json'), {
      mcpServers: {
        playwright: { command: 'npx', args: ['@playwright/mcp@latest'], [DEVIA_MANAGED_KEY]: 'playwright' },
      },
    });
    writeJson(path.join(tmp, '.claude.json'), {
      theme: 'dark',
      projects: { '/some/path': { mcpServers: {} } },
    });

    const result = migrateLegacyMcpPaths({ home: tmp, log: NOOP_LOG });

    expect(result.movedEntries).toEqual([
      { from: path.join(tmp, '.claude', 'mcp.json'), to: path.join(tmp, '.claude.json'), ids: ['playwright'] },
    ]);

    const target = readJson(path.join(tmp, '.claude.json'));
    expect(target['theme']).toBe('dark');                 // unrelated keys preserved
    expect(target['projects']).toBeDefined();
    expect((target['mcpServers'] as Record<string, unknown>)['playwright']).toEqual({
      command: 'npx',
      args: ['@playwright/mcp@latest'],
      [DEVIA_MANAGED_KEY]: 'playwright',
    });
    // Source file removed when only Devia entries were there.
    expect(fs.existsSync(path.join(tmp, '.claude', 'mcp.json'))).toBe(false);
  });

  it('keeps hand-edited entries in the source and rewrites it without Devia entries', () => {
    writeJson(path.join(tmp, '.claude', 'mcp.json'), {
      mcpServers: {
        playwright: { command: 'npx', args: ['x'], [DEVIA_MANAGED_KEY]: 'playwright' },
        myHandSever: { command: 'mine', args: [] }, // no marker
      },
    });

    migrateLegacyMcpPaths({ home: tmp, log: NOOP_LOG });

    const source = readJson(path.join(tmp, '.claude', 'mcp.json'));
    expect((source['mcpServers'] as Record<string, unknown>)['myHandSever']).toBeDefined();
    expect((source['mcpServers'] as Record<string, unknown>)['playwright']).toBeUndefined();

    const target = readJson(path.join(tmp, '.claude.json'));
    expect((target['mcpServers'] as Record<string, unknown>)['playwright']).toBeDefined();
  });

  it('is a no-op when there are no Devia-managed entries', () => {
    writeJson(path.join(tmp, '.claude', 'mcp.json'), {
      mcpServers: { handAdded: { command: 'foo', args: [] } },
    });

    const result = migrateLegacyMcpPaths({ home: tmp, log: NOOP_LOG });

    expect(result.movedEntries).toEqual([]);
    expect(fs.existsSync(path.join(tmp, '.claude', 'mcp.json'))).toBe(true);
    expect(fs.existsSync(path.join(tmp, '.claude.json'))).toBe(false);
  });

  it('is idempotent — running again with the source already gone does nothing', () => {
    const first = migrateLegacyMcpPaths({ home: tmp, log: NOOP_LOG });
    expect(first.movedEntries).toEqual([]);
    const second = migrateLegacyMcpPaths({ home: tmp, log: NOOP_LOG });
    expect(second.movedEntries).toEqual([]);
  });
});

describe('migrateLegacyMcpPaths — copilot global', () => {
  it('moves ~/.copilot/mcp.json → ~/.copilot/mcp-config.json', () => {
    writeJson(path.join(tmp, '.copilot', 'mcp.json'), {
      mcpServers: {
        playwright: { command: 'npx', args: ['x'], [DEVIA_MANAGED_KEY]: 'playwright' },
      },
    });

    const result = migrateLegacyMcpPaths({ home: tmp, log: NOOP_LOG });

    expect(result.movedEntries.length).toBe(1);
    expect(fs.existsSync(path.join(tmp, '.copilot', 'mcp.json'))).toBe(false);
    const target = readJson(path.join(tmp, '.copilot', 'mcp-config.json'));
    expect((target['mcpServers'] as Record<string, unknown>)['playwright']).toBeDefined();
  });
});

describe('migrateLegacyMcpPaths — opencode project', () => {
  it('moves <project>/.opencode/opencode.json → <project>/opencode.json (under key "mcp")', () => {
    const project = path.join(tmp, 'myproj');
    writeJson(path.join(project, '.opencode', 'opencode.json'), {
      mcp: {
        playwright: { command: 'npx', args: ['x'], [DEVIA_MANAGED_KEY]: 'playwright' },
      },
    });

    const result = migrateLegacyMcpPaths({
      home: tmp,
      lastProjectPath: project,
      log: NOOP_LOG,
    });

    expect(result.movedEntries.length).toBe(1);
    expect(fs.existsSync(path.join(project, '.opencode', 'opencode.json'))).toBe(false);
    const target = readJson(path.join(project, 'opencode.json'));
    expect((target['mcp'] as Record<string, unknown>)['playwright']).toBeDefined();
  });

  it('does nothing when lastProjectPath is not provided', () => {
    const project = path.join(tmp, 'myproj');
    writeJson(path.join(project, '.opencode', 'opencode.json'), {
      mcp: { x: { command: 'a', args: [], [DEVIA_MANAGED_KEY]: 'x' } },
    });

    const result = migrateLegacyMcpPaths({ home: tmp, log: NOOP_LOG });
    expect(result.movedEntries).toEqual([]);
    expect(fs.existsSync(path.join(project, '.opencode', 'opencode.json'))).toBe(true);
  });
});

describe('migrateLegacyMcpPaths — survives malformed input', () => {
  it('skips malformed JSON without throwing', () => {
    fs.mkdirSync(path.join(tmp, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.claude', 'mcp.json'), '{ not json', 'utf8');

    expect(() => migrateLegacyMcpPaths({ home: tmp, log: NOOP_LOG })).not.toThrow();
  });
});
