import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { McpServerConfig } from '../../../../shared/domain/mcp';
import { claudeAgentDef } from '../../cli-adapters/infrastructure/defs/claude';
import { makeRunPlan } from '../testing/make-run-plan';
import { ClaudeMapper } from './mapper';

let project: string;
let deviaDir: string;
beforeEach(() => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'devia-claude-map-'));
  deviaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devia-claude-dd-'));
});
afterEach(() => {
  fs.rmSync(project, { recursive: true, force: true });
  fs.rmSync(deviaDir, { recursive: true, force: true });
});

const server = (id: string): McpServerConfig => ({ id, name: id, command: 'node', args: [`${id}.js`], enabled: true });
const mapper = (enterprise = false): ClaudeMapper =>
  new ClaudeMapper(claudeAgentDef, { nativeMcp: { deliver: () => ({ file: null, deliveredServerIds: [] }) }, enterpriseMcpConfigPresent: () => enterprise });
const planWith = (overrides = {}) => makeRunPlan({
  agentId: 'claude', cwd: project, deviaDir,
  harness: { mcp: { devia: [server('devia-kanban'), server('devia-ui')], user: [server('github')] }, skills: [], subagents: [], isolateExternalMcp: true },
  ...overrides,
});
const args = (m: ClaudeMapper, plan = planWith()): string[] => {
  const prepared = m.prepareRun(plan, 'SYS', m.resolveDelivery(plan));
  if (!prepared.ok) throw new Error(prepared.error);
  return [...prepared.run.args];
};

describe('ClaudeMapper', () => {
  it('drops Workflow outside plan mode only', () => {
    expect(mapper().disallowedTools('apply')).toContain('Workflow');
    expect(mapper().disallowedTools('plan')).not.toContain('Workflow');
  });

  it('delivers user + Devia servers through --mcp-config, grants them and isolates external MCP', () => {
    const a = args(mapper());
    const config = JSON.parse(fs.readFileSync(a[a.indexOf('--mcp-config') + 1] ?? '', 'utf8')) as { mcpServers: object };
    expect(Object.keys(config.mcpServers)).toEqual(['github', 'devia-kanban', 'devia-ui']);
    expect(a).toContain('--strict-mcp-config');
    const allow = JSON.parse(fs.readFileSync(path.join(project, '.claude', 'settings.local.json'), 'utf8')).permissions.allow;
    expect(allow).toEqual(expect.arrayContaining(['mcp__github', 'mcp__devia-kanban', 'mcp__devia-ui']));
  });

  it('passes neither MCP flag under an enterprise MCP policy, and says why', () => {
    const plan = planWith();
    expect(mapper(true).resolveDelivery(plan).notices[0]).toMatch(/empresa/);
    const a = args(mapper(true), plan);
    expect(a).not.toContain('--mcp-config');
    expect(a).not.toContain('--strict-mcp-config');
  });

  it('appends the system prompt and resumes natively', () => {
    const a = args(mapper(), planWith({ resumeSessionId: 'sess-9' }));
    expect(a[a.indexOf('--append-system-prompt') + 1]).toBe('SYS');
    expect(a.slice(a.indexOf('--resume'), a.indexOf('--resume') + 2)).toEqual(['--resume', 'sess-9']);
  });

  it('passes Devia sub-agents natively with --agents, except one already in .claude/agents', () => {
    const subDir = path.join(project, '.devia', 'sub-agents');
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(path.join(subDir, 'reviewer.md'), '---\nname: reviewer\ndescription: Reviews\ntools: Read, Grep\nagents: [claude]\n---\nBe strict.');
    fs.writeFileSync(path.join(subDir, 'native.md'), '---\nname: native\ndescription: N\nagents: [claude]\n---\nX');
    fs.mkdirSync(path.join(project, '.claude', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(project, '.claude', 'agents', 'native.md'), 'already there');
    const plan = planWith({
      harness: {
        mcp: { devia: [], user: [] }, skills: [], isolateExternalMcp: false,
        subagents: [
          { name: 'reviewer', description: 'Reviews', file: path.join(subDir, 'reviewer.md') },
          { name: 'native', description: 'N', file: path.join(subDir, 'native.md') },
        ],
      },
    });
    const prepared = mapper().prepareRun(plan, 'SYS', mapper().resolveDelivery(plan));
    if (!prepared.ok) throw new Error(prepared.error);
    const a = prepared.run.args;
    const file = a[a.indexOf('--agents') + 1] ?? '';
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({
      reviewer: { description: 'Reviews', prompt: 'Be strict.', tools: ['Read', 'Grep'] },
    });
    prepared.run.cleanup();
    expect(fs.existsSync(file)).toBe(false);
  });

  it('tells the devia-ui server where to meet the core', () => {
    const plan = planWith();
    const prepared = mapper().prepareRun(plan, 'SYS', mapper().resolveDelivery(plan));
    if (!prepared.ok) throw new Error(prepared.error);
    expect(prepared.run.agentEnv).toMatchObject({ DEVIA_UI_DIR: plan.ui.rendezvousDir, DEVIA_UI_TOOL_TIMEOUT_MS: '300000' });
  });
});
