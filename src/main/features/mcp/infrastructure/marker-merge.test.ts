import { describe, it, expect } from 'vitest';
import type { McpServerConfig } from '../../../../shared/domain/mcp';
import { mergeJson, mergeToml, DEVIA_MANAGED_KEY } from './marker-merge';

const noEnv = () => ({});

function makeServer(id: string, overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    id,
    name: id,
    command: 'npx',
    args: ['-y', `@example/${id}`],
    enabled: true,
    agents: ['claude'],
    scope: 'global',
    source: 'npm',
    ...overrides,
  };
}

describe('mergeJson', () => {
  it('inserts a Devia-managed entry with the __devia_managed marker', () => {
    const out = mergeJson(null, {
      parentKey: 'mcpServers',
      managed: [makeServer('alpha')],
      composeEnv: noEnv,
    });
    const servers = (out['mcpServers'] as Record<string, Record<string, unknown>>);
    expect(servers['alpha']?.[DEVIA_MANAGED_KEY]).toBe('alpha');
    expect(servers['alpha']?.['command']).toBe('npx');
  });

  it('preserves hand-added entries (no marker) on subsequent merges', () => {
    const root = {
      mcpServers: {
        alpha: { command: 'npx', args: ['-y', 'old-alpha'] }, // hand-edited
      },
    };
    const out = mergeJson(root, {
      parentKey: 'mcpServers',
      managed: [makeServer('beta')],
      composeEnv: noEnv,
    });
    const servers = (out['mcpServers'] as Record<string, Record<string, unknown>>);
    expect(servers['alpha']?.[DEVIA_MANAGED_KEY]).toBeUndefined();
    expect(servers['alpha']?.['args']).toEqual(['-y', 'old-alpha']);
    expect(servers['beta']?.[DEVIA_MANAGED_KEY]).toBe('beta');
  });

  it('overwrites a Devia-managed entry when re-merged', () => {
    const root = {
      mcpServers: {
        alpha: { command: 'old', args: [], [DEVIA_MANAGED_KEY]: 'alpha' },
      },
    };
    const out = mergeJson(root, {
      parentKey: 'mcpServers',
      managed: [makeServer('alpha')],
      composeEnv: noEnv,
    });
    const servers = (out['mcpServers'] as Record<string, Record<string, unknown>>);
    expect(servers['alpha']?.['command']).toBe('npx');
  });

  it('removes Devia-managed entries that disappear from the catalog', () => {
    const root = {
      mcpServers: {
        alpha: { command: 'x', args: [], [DEVIA_MANAGED_KEY]: 'alpha' },
        beta:  { command: 'y', args: [], [DEVIA_MANAGED_KEY]: 'beta' },
      },
    };
    const out = mergeJson(root, {
      parentKey: 'mcpServers',
      managed: [makeServer('alpha')], // beta dropped from catalog
      composeEnv: noEnv,
    });
    const servers = (out['mcpServers'] as Record<string, Record<string, unknown>>);
    expect(servers['beta']).toBeUndefined();
    expect(servers['alpha']?.[DEVIA_MANAGED_KEY]).toBe('alpha');
  });

  it('emits the exposure field only when asked (pi targets)', () => {
    const out = mergeJson(null, {
      parentKey: 'mcpServers',
      managed: [makeServer('alpha', { exposure: 'direct' })],
      composeEnv: noEnv,
      emitExposure: true,
    });
    const servers = (out['mcpServers'] as Record<string, Record<string, unknown>>);
    expect(servers['alpha']?.['exposure']).toBe('direct');
  });

  it('never leaks exposure to agents that validate their schema', () => {
    const out = mergeJson(null, {
      parentKey: 'mcpServers',
      managed: [makeServer('alpha', { exposure: 'direct' })],
      composeEnv: noEnv,
    });
    const servers = (out['mcpServers'] as Record<string, Record<string, unknown>>);
    expect(servers['alpha']?.['exposure']).toBeUndefined();
  });

  it('keeps the other bundled servers when one injector writes with prune:false', () => {
    // memory → ui → kanban, each writing only its own server, used to leave
    // only kanban in the file.
    let root: Record<string, unknown> | null = null;
    for (const id of ['devia-memory', 'devia-ui', 'devia-kanban']) {
      root = mergeJson(root, { parentKey: 'mcpServers', managed: [makeServer(id)], composeEnv: noEnv, prune: false });
    }
    expect(Object.keys(root?.['mcpServers'] as object).sort()).toEqual(['devia-kanban', 'devia-memory', 'devia-ui']);
  });

  it('keeps user catalog servers when an injector writes with prune:false', () => {
    const root = mergeJson(null, { parentKey: 'mcpServers', managed: [makeServer('github')], composeEnv: noEnv });
    const out = mergeJson(root, { parentKey: 'mcpServers', managed: [makeServer('devia-memory')], composeEnv: noEnv, prune: false });
    expect(Object.keys(out['mcpServers'] as object).sort()).toEqual(['devia-memory', 'github']);
  });

  it('a catalog sync never prunes the bundled servers, only unlisted catalog ones', () => {
    let root = mergeJson(null, {
      parentKey: 'mcpServers',
      managed: [makeServer('devia-kanban'), makeServer('devia-ui'), makeServer('old-user-server')],
      composeEnv: noEnv,
    });
    root = mergeJson(root, { parentKey: 'mcpServers', managed: [makeServer('github')], composeEnv: noEnv });
    expect(Object.keys(root['mcpServers'] as object).sort()).toEqual(['devia-kanban', 'devia-ui', 'github']);
  });

  it('removes a bundled server when it is explicitly listed in removedIds', () => {
    const root = mergeJson(null, { parentKey: 'mcpServers', managed: [makeServer('devia-ui')], composeEnv: noEnv });
    const out = mergeJson(root, { parentKey: 'mcpServers', managed: [], removedIds: ['devia-ui'], composeEnv: noEnv, prune: false });
    expect(out['mcpServers']).toBeUndefined();
  });

  it('writes OpenCode entries in the McpLocalConfig shape', () => {
    const out = mergeJson(null, {
      parentKey: 'mcp',
      entryShape: 'opencode-local',
      managed: [makeServer('alpha', {
        command: 'npx',
        args: ['-y', '@playwright/mcp@latest'],
        env: { TOKEN: 'x' },
        allowedEnvKeys: ['TOKEN'],
      })],
      composeEnv: (s) => s.env ?? {},
    });
    const servers = (out['mcp'] as Record<string, Record<string, unknown>>);
    const alpha = servers['alpha'];
    expect(alpha?.['type']).toBe('local');
    // `command` is the WHOLE argv array (command + args), not a string.
    expect(alpha?.['command']).toEqual(['npx', '-y', '@playwright/mcp@latest']);
    // env lives under `environment`, never `env`/`args`.
    expect(alpha?.['environment']).toEqual({ TOKEN: 'x' });
    expect(alpha?.['args']).toBeUndefined();
    expect(alpha?.['env']).toBeUndefined();
    // Marker is still a sibling (OpenCode ignores unknown keys at runtime).
    expect(alpha?.[DEVIA_MANAGED_KEY]).toBe('alpha');
  });

  it('omits `environment` for an OpenCode entry with no env', () => {
    const out = mergeJson(null, {
      parentKey: 'mcp',
      entryShape: 'opencode-local',
      managed: [makeServer('alpha')],
      composeEnv: noEnv,
    });
    const alpha = (out['mcp'] as Record<string, Record<string, unknown>>)['alpha'];
    expect('environment' in (alpha ?? {})).toBe(false);
  });

  it('never writes exposure in the OpenCode shape', () => {
    const out = mergeJson(null, {
      parentKey: 'mcp',
      entryShape: 'opencode-local',
      managed: [makeServer('alpha', { exposure: 'deferred' })],
      composeEnv: noEnv,
      emitExposure: true,
    });
    const servers = (out['mcp'] as Record<string, Record<string, unknown>>);
    expect(servers['alpha']?.['exposure']).toBeUndefined();
  });

  it('still detects and removes Devia-managed OpenCode entries by marker', () => {
    const root = {
      mcp: {
        alpha: { type: 'local', command: ['x'], [DEVIA_MANAGED_KEY]: 'alpha' },
        userBuilt: { type: 'local', command: ['userbin'] }, // hand-added, no marker
      },
    };
    const out = mergeJson(root, {
      parentKey: 'mcp',
      entryShape: 'opencode-local',
      managed: [], // alpha dropped from catalog
      removedIds: ['alpha'],
      composeEnv: noEnv,
    });
    const servers = (out['mcp'] as Record<string, Record<string, unknown>>);
    expect(servers['alpha']).toBeUndefined();
    // Hand-added entry survives.
    expect(servers['userBuilt']?.['command']).toEqual(['userbin']);
  });

  it('drops the parent key entirely when no servers remain', () => {
    const root = {
      mcpServers: {
        alpha: { command: 'x', args: [], [DEVIA_MANAGED_KEY]: 'alpha' },
      },
    };
    const out = mergeJson(root, {
      parentKey: 'mcpServers',
      managed: [],
      removedIds: ['alpha'],
      composeEnv: noEnv,
    });
    expect(out['mcpServers']).toBeUndefined();
  });
});

describe('mergeToml', () => {
  it('wraps a managed section with start/end markers', () => {
    const out = mergeToml('', [makeServer('alpha')], noEnv);
    expect(out).toContain('# devia-mcp-start alpha');
    expect(out).toContain('[mcp_servers.alpha]');
    expect(out).toContain('command = "npx"');
    expect(out).toContain('# devia-mcp-end alpha');
  });

  it('preserves hand-added TOML sections between merges', () => {
    const initial = `
[mcp_servers.userBuilt]
command = "userbin"
args = ["--foo"]
`.trim();
    const out = mergeToml(initial, [makeServer('alpha')], noEnv);
    expect(out).toContain('[mcp_servers.userBuilt]');
    expect(out).toContain('command = "userbin"');
    expect(out).toContain('# devia-mcp-start alpha');
  });

  it('replaces an existing managed block on re-merge', () => {
    const first = mergeToml('', [makeServer('alpha', { args: ['-y', 'v1'] })], noEnv);
    const second = mergeToml(first, [makeServer('alpha', { args: ['-y', 'v2'] })], noEnv);
    expect(second).toContain('"v2"');
    expect(second).not.toContain('"v1"');
    // Still exactly one start marker for alpha.
    expect((second.match(/devia-mcp-start alpha/g) ?? []).length).toBe(1);
  });

  it('removes a managed block when the id is in removedIds', () => {
    const initial = mergeToml('', [makeServer('alpha')], noEnv);
    const after = mergeToml(initial, [], noEnv, ['alpha']);
    expect(after).not.toContain('alpha');
  });

  it('emits the codex tuning keys when set on the server', () => {
    const out = mergeToml(
      '',
      [makeServer('alpha', { startupTimeoutSec: 30, defaultToolsApprovalMode: 'auto' })],
      noEnv,
    );
    expect(out).toContain('startup_timeout_sec = 30');
    expect(out).toContain('default_tools_approval_mode = "auto"');
    // Inside the managed block (before the end marker).
    expect(out.indexOf('startup_timeout_sec')).toBeLessThan(out.indexOf('# devia-mcp-end alpha'));
  });

  it('omits the codex tuning keys when not set', () => {
    const out = mergeToml('', [makeServer('alpha')], noEnv);
    expect(out).not.toContain('startup_timeout_sec');
    expect(out).not.toContain('default_tools_approval_mode');
  });

  it('never writes the pi-only exposure key into codex TOML', () => {
    const out = mergeToml('', [makeServer('alpha', { exposure: 'direct' })], noEnv);
    expect(out).not.toContain('exposure');
  });
});
