import { describe, it, expect, vi } from 'vitest';
import type { McpServerConfig } from '../../../../../shared/domain/mcp';
import { makeRunPlan } from '../../testing/make-run-plan';
import { mcpStrategyFor, resolveLegacyMcpDelivery } from './legacy-mcp';

const server = (id: string): McpServerConfig => ({ id, name: id, command: 'node', args: [], enabled: true });
const plan = makeRunPlan({
  harness: { mcp: { devia: [server('devia-kanban'), server('devia-ui')], user: [server('github')] }, skills: [], subagents: [], isolateExternalMcp: true },
});
const nativeMcp = (ids: string[]) => ({ deliver: vi.fn(() => ({ file: '/f', deliveredServerIds: ids })) });

describe('legacy MCP strategies', () => {
  it('picks the strategy each CLI supports', () => {
    // Claude has its own mapper (T-349) and never reaches these strategies.
    expect(mcpStrategyFor('claude')).toBe('none');
    // Claude and pi have their own mappers and never reach these strategies.
    expect(mcpStrategyFor('pi')).toBe('none');
    expect(mcpStrategyFor('gemini')).toBe('native-config');
    expect(mcpStrategyFor('codex')).toBe('native-config');
    expect(mcpStrategyFor('deepseek')).toBe('none');
  });

  it('a native-config agent gets exactly what its config write delivered', () => {
    const deps = { nativeMcp: nativeMcp(['devia-kanban']) };
    expect(resolveLegacyMcpDelivery('gemini', 'Gemini', plan, deps).mcpServerIds).toEqual(['devia-kanban']);
    expect(deps.nativeMcp.deliver).toHaveBeenCalledWith('gemini', plan.cwd, plan.harness.mcp.devia);
  });

  it('warns when the user configured servers an agent cannot load (UC-FIX-005)', () => {
    const out = resolveLegacyMcpDelivery('deepseek', 'DeepSeek', plan, { nativeMcp: nativeMcp([]) });
    expect(out.mcpServerIds).toEqual([]);
    expect(out.notices[0]).toContain('not supported by DeepSeek');
  });
});

describe('the harness travels (T-356)', () => {
  it('skills and sub-agents ride devia_skill wherever devia-ui is delivered', () => {
    const withHarness = makeRunPlan({
      harness: {
        ...plan.harness,
        skills: [{ name: 's', description: '', dir: '/p/.claude/skills/s' }],
        subagents: [{ name: 'a', description: '', file: '/p/.devia/sub-agents/a.md' }],
      },
    });
    expect(resolveLegacyMcpDelivery('gemini', 'Gemini', withHarness, { nativeMcp: nativeMcp(['devia-kanban', 'devia-ui']) }))
      .toMatchObject({ skills: 'devia', subagents: 'devia' });
    expect(resolveLegacyMcpDelivery('deepseek', 'DeepSeek', withHarness, { nativeMcp: nativeMcp([]) }))
      .toMatchObject({ skills: 'none', subagents: 'none' });
  });
});
