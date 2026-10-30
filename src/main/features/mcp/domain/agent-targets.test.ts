/**
 * Per-agent MCP target paths — locks the values down so we notice
 * when an upstream CLI moves them again. Source of truth + vendor URLs
 * live in `docs/mcp/01-cli-paths-audit.md` (T-49).
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveAgentTarget, targetsForServer } from './agent-targets';

const HOME = '/u/test';
const PROJECT = '/repos/devia';
const ctx = { home: HOME, project: PROJECT };

describe('resolveAgentTarget — claude', () => {
  it('global writes to ~/.claude.json (top-level mcpServers), NOT ~/.claude/mcp.json', () => {
    // Regression guard: the legacy path is a no-op for Claude Code, which
    // reads `~/.claude.json`. See T-50 of S-3.
    const t = resolveAgentTarget('claude', 'global', ctx);
    expect(t).toEqual({
      file: path.join(HOME, '.claude.json'),
      strategy: 'json-merge',
      jsonParentKey: 'mcpServers',
    });
  });

  it('project writes to <project>/.mcp.json', () => {
    const t = resolveAgentTarget('claude', 'project', ctx);
    expect(t?.file).toBe(path.join(PROJECT, '.mcp.json'));
    expect(t?.jsonParentKey).toBe('mcpServers');
    expect(t?.strategy).toBe('json-merge');
  });
});

describe('resolveAgentTarget — opencode', () => {
  it('global writes to ~/.config/opencode/opencode.json under key "mcp"', () => {
    const t = resolveAgentTarget('opencode', 'global', ctx);
    expect(t?.file).toBe(path.join(HOME, '.config', 'opencode', 'opencode.json'));
    expect(t?.jsonParentKey).toBe('mcp');
    // OpenCode needs the McpLocalConfig entry shape (not standard command/args).
    expect(t?.jsonEntryShape).toBe('opencode-local');
  });

  it('project writes to <project>/opencode.json at the root (no .opencode dir)', () => {
    // Regression guard: `.opencode/` is for agents/skills/plugins, NOT
    // the config file. See T-50 of S-3.
    const t = resolveAgentTarget('opencode', 'project', ctx);
    expect(t?.file).toBe(path.join(PROJECT, 'opencode.json'));
    expect(t?.jsonParentKey).toBe('mcp');
    expect(t?.jsonEntryShape).toBe('opencode-local');
  });
});

describe('resolveAgentTarget — copilot', () => {
  it('global writes to ~/.copilot/mcp-config.json (the `-config` suffix matters)', () => {
    const t = resolveAgentTarget('copilot', 'global', ctx);
    expect(t?.file).toBe(path.join(HOME, '.copilot', 'mcp-config.json'));
    expect(t?.jsonParentKey).toBe('mcpServers');
  });

  it('project returns null — the Copilot CLI has no documented project file', () => {
    // `.vscode/mcp.json` is the VS Code extension's file (key `servers`,
    // not `mcpServers`). The CLI doesn't read it. See T-50 of S-3.
    expect(resolveAgentTarget('copilot', 'project', ctx)).toBeNull();
  });
});

describe('resolveAgentTarget — codex / gemini / cursor-agent / qwen (unchanged)', () => {
  it.each([
    ['codex',        'global',  path.join(HOME, '.codex', 'config.toml')],
    ['codex',        'project', path.join(PROJECT, '.codex', 'config.toml')],
    ['gemini',       'global',  path.join(HOME, '.gemini', 'settings.json')],
    ['gemini',       'project', path.join(PROJECT, '.gemini', 'settings.json')],
    ['cursor-agent', 'global',  path.join(HOME, '.cursor', 'mcp.json')],
    ['cursor-agent', 'project', path.join(PROJECT, '.cursor', 'mcp.json')],
    ['qwen',         'global',  path.join(HOME, '.qwen', 'settings.json')],
    ['qwen',         'project', path.join(PROJECT, '.qwen', 'settings.json')],
  ] as const)('%s / %s → %s', (agent, scope, expectedFile) => {
    const t = resolveAgentTarget(agent, scope, ctx);
    expect(t?.file).toBe(expectedFile);
  });
});

describe('resolveAgentTarget — project scope requires ctx.project', () => {
  it.each(['claude', 'codex', 'gemini', 'opencode', 'cursor-agent', 'qwen'] as const)(
    'returns null for %s/project when ctx.project is missing',
    (agent) => {
      expect(resolveAgentTarget(agent, 'project', { home: HOME })).toBeNull();
    },
  );
});

describe('targetsForServer', () => {
  it('skips agents that resolve to null (copilot/project)', () => {
    const targets = targetsForServer(['claude', 'copilot', 'gemini'], 'project', ctx);
    expect(targets.map((t) => t.agent)).toEqual(['claude', 'gemini']);
  });
});
