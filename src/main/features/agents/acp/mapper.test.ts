import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { kimiAgentDef } from '../../cli-adapters/infrastructure/defs/kimi';
import type { AgentRunPlan } from '../domain';
import type { MapperDeps } from '../infrastructure/mapper-deps';
import { makeRunPlan } from '../testing/make-run-plan';
import { AcpMapper } from './mapper';
import { profileFor, type AcpAgentProfile } from './profile';
import { createFakeChild } from './testing/fake-child';
import { mcpServer } from './testing/fake-plan';

const KIMI = profileFor('kimi') as AcpAgentProfile;
const DEPS = { nativeMcp: { deliver: () => undefined } } as unknown as MapperDeps;
const mapper = (profile: AcpAgentProfile = KIMI): AcpMapper => new AcpMapper(kimiAgentDef, profile, DEPS);

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function planWith(over: Partial<AgentRunPlan> = {}): AgentRunPlan {
  return makeRunPlan({
    agentId: 'kimi',
    harness: {
      mcp: {
        devia: [mcpServer('devia-kanban'), mcpServer('devia-ui')],
        user: [mcpServer('github')],
      },
      skills: [{ name: 's', description: 'd', dir: '/skills/s' }],
      subagents: [{ name: 'a', description: 'd', file: '/agents/a.md' }],
      isolateExternalMcp: false,
    },
    ...over,
  });
}

describe('AcpMapper', () => {
  it('declares native MCP and Devia-channel skills and sub-agents', () => {
    expect(mapper().id).toBe('kimi');
    expect(mapper().harnessSupport).toEqual({ mcp: 'native', skills: 'devia', subagents: 'devia' });
  });

  it('freezesSystemPrompt and isolatesExternalMcp are false', () => {
    expect(mapper().freezesSystemPrompt).toBe(false);
    expect(mapper().isolatesExternalMcp).toBe(false);
  });

  it('delivers user and Devia servers through the MCP list, no files written', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'acp-mapper-'));
    dirs.push(root);
    const plan = planWith({ cwd: root, deviaDir: root });
    const m = mapper();
    const delivery = m.resolveDelivery(plan);
    expect(delivery.mcpServerIds).toEqual(['github', 'devia-kanban', 'devia-ui']);
    const prepared = m.prepareRun(plan, 'SYS', delivery);
    expect(prepared.ok && prepared.run.mcpServerIds).toEqual(['github', 'devia-kanban', 'devia-ui']);
    expect(readdirSync(root)).toEqual([]);
  });

  it('skills and sub-agents reach the agent only with devia-ui delivered', () => {
    expect(mapper().resolveDelivery(planWith())).toMatchObject({ skills: 'devia', subagents: 'devia' });
    const noUi = planWith({
      harness: { ...planWith().harness, mcp: { devia: [mcpServer('devia-kanban')], user: [] } },
    });
    expect(mapper().resolveDelivery(noUi)).toMatchObject({ skills: 'none', subagents: 'none' });
    const nothing = planWith({ harness: { ...planWith().harness, skills: [], subagents: [] } });
    expect(mapper().resolveDelivery(nothing)).toMatchObject({ skills: 'none', subagents: 'none' });
  });

  it('plan mode with planEnforcement none warns, apply mode does not, and a policy profile never warns', () => {
    const warned = mapper().resolveDelivery(planWith({ mode: 'plan' }));
    expect(warned.notices).toEqual(['Plan mode is not enforced by Kimi CLI: it may still modify files.']);
    expect(mapper().resolveDelivery(planWith({ mode: 'apply' })).notices).toEqual([]);
    expect(mapper().resolveDelivery(planWith({ mode: 'apply-yolo' })).notices).toEqual([]);
    const enforced = mapper({ ...KIMI, planEnforcement: 'permission-policy' });
    expect(enforced.resolveDelivery(planWith({ mode: 'plan' })).notices).toEqual([]);
    const byMode = mapper({ ...KIMI, planEnforcement: 'agent-mode' });
    expect(byMode.resolveDelivery(planWith({ mode: 'plan' })).notices).toEqual([]);
  });

  it("prepareRun returns the profile argv, session stdin and the user's env overrides", () => {
    const plan = planWith({ envOverrides: { KIMI_X: '1' } });
    const m = mapper();
    const prepared = m.prepareRun(plan, 'SYS', m.resolveDelivery(plan));
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.run.args).toEqual(['acp']);
    expect(prepared.run.stdin).toEqual({ kind: 'session' });
    expect(prepared.run.env).toEqual({ KIMI_X: '1' });
    expect(prepared.run.notices).toEqual([]);
  });

  it('prepareRun is repeatable and cleanup is idempotent', () => {
    const plan = planWith();
    const m = mapper();
    const delivery = m.resolveDelivery(plan);
    const a = m.prepareRun(plan, 'ONE', delivery);
    const b = m.prepareRun(plan, 'TWO', delivery);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    a.run.cleanup();
    a.run.cleanup();
    b.run.cleanup();
    expect(() => b.run.cleanup()).not.toThrow();
  });

  it('openSession hands the stored system prompt to the session', async () => {
    const plan = planWith({ prompt: 'hello' });
    const m = mapper();
    m.prepareRun(plan, 'SYS', m.resolveDelivery(plan));
    const child = createFakeChild({ turns: [{ steps: [{ type: 'text', text: 'hi' }] }] });
    m.openSession(child.io, plan);
    await waitForTurn(child.events);
    expect(child.record.prompts[0]).toMatchObject({ prompt: [{ type: 'text', text: '[System]\nSYS\n\n[User]\nhello' }] });
    expect(child.record.newSession).toMatchObject({
      mcpServers: [{ name: 'github' }, { name: 'devia-kanban' }, { name: 'devia-ui' }],
    });
  });

  it('a run without prepareRun still opens with an empty system prompt without throwing', async () => {
    const plan = planWith({ prompt: 'plain' });
    const child = createFakeChild({ turns: [{ steps: [{ type: 'text', text: 'hi' }] }] });
    expect(() => mapper().openSession(child.io, plan)).not.toThrow();
    await waitForTurn(child.events);
    expect(child.record.prompts[0]).toMatchObject({ prompt: [{ type: 'text', text: 'plain' }] });
  });

  it('forgets the stored prompt after cleanup', async () => {
    const plan = planWith({ prompt: 'again' });
    const m = mapper();
    const prepared = m.prepareRun(plan, 'SYS', m.resolveDelivery(plan));
    if (!prepared.ok) throw new Error('prepare failed');
    prepared.run.cleanup();
    const child = createFakeChild({ turns: [{ steps: [{ type: 'text', text: 'hi' }] }] });
    m.openSession(child.io, plan);
    await waitForTurn(child.events);
    expect(child.record.prompts[0]).toMatchObject({ prompt: [{ type: 'text', text: 'again' }] });
  });
});

async function waitForTurn(events: { type: string }[]): Promise<void> {
  const end = Date.now() + 2000;
  while (!events.some((e) => e.type === 'turn_end' || e.type === 'error')) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}
