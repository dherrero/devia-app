import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { McpServerConfig } from '../../../../shared/domain/mcp';
import type { RunId } from '../../../../shared/domain/agent';
import { buildDefaultCapabilities } from '../../../../shared/domain/run-capabilities';
import { piAgentDef } from '../../cli-adapters/infrastructure/defs/pi';
import { makeRunPlan } from '../testing/make-run-plan';
import { PiMapper } from './mapper';

let project: string;
let deviaDir: string;
beforeEach(() => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'devia-pi-map-'));
  deviaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devia-pi-dd-'));
});
afterEach(() => {
  fs.rmSync(project, { recursive: true, force: true });
  fs.rmSync(deviaDir, { recursive: true, force: true });
});

const server = (id: string): McpServerConfig => ({ id, name: id, command: 'node', args: [`${id}.js`], enabled: true });
const mapper = new PiMapper(piAgentDef, { nativeMcp: { deliver: () => ({ file: null, deliveredServerIds: [] }) } });
const planWith = (overrides = {}) => makeRunPlan({
  agentId: 'pi', cwd: project, deviaDir,
  harness: {
    mcp: { devia: [server('devia-kanban'), server('devia-ui')], user: [server('e2e-echo')] },
    skills: [{ name: 'e2e-skill', description: '', dir: path.join(project, '.agents', 'skills', 'e2e-skill') }],
    subagents: [{ name: 'reviewer', description: '', file: '/x/reviewer.md' }],
    isolateExternalMcp: true,
  },
  ...overrides,
});
const prepare = (plan = planWith()) => {
  const prepared = mapper.prepareRun(plan, 'SYS', mapper.resolveDelivery(plan));
  if (!prepared.ok) throw new Error(prepared.error);
  return prepared.run;
};

describe('PiMapper', () => {
  it('registers the user AND Devia servers in one per-run extension', () => {
    const run = prepare();
    const ext = run.args[run.args.indexOf('-e') + 1] ?? '';
    const source = fs.readFileSync(ext, 'utf8');
    for (const id of ['e2e-echo', 'devia-kanban', 'devia-ui']) expect(source).toContain(`"${id}"`);
    expect(run.mcpServerIds).toEqual(['e2e-echo', 'devia-kanban', 'devia-ui']);
    run.cleanup();
    expect(fs.existsSync(ext)).toBe(false);
  });

  it('passes every Devia skill natively with --skill; sub-agents ride devia_skill', () => {
    const plan = planWith();
    expect(mapper.resolveDelivery(plan)).toMatchObject({ skills: 'native', subagents: 'devia' });
    const run = prepare(plan);
    expect(run.args.slice(run.args.indexOf('--skill'), run.args.indexOf('--skill') + 2))
      .toEqual(['--skill', path.join(project, '.agents', 'skills', 'e2e-skill')]);
  });

  it('strips stale Devia entries from .pi/mcp.json — a file entry would override the registration', () => {
    const file = path.join(project, '.pi', 'mcp.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { 'devia-ui': { command: 'old', __devia_managed: 'devia-ui' } } }));
    prepare();
    expect(fs.existsSync(file)).toBe(false);
  });

  it('system prompt by file, plan-mode read-only tools, native resume', () => {
    const run = prepare(planWith({ mode: 'plan', capabilities: buildDefaultCapabilities('run-1' as RunId, 'plan'), resumeSessionId: 'sess-1' }));
    expect(run.args).toEqual(expect.arrayContaining(['--tools', 'read,grep,find,ls,mcp__*', '--session-id', 'sess-1', '--append-system-prompt']));
    expect(run.stdin).toEqual({ kind: 'session' });
    expect(mapper.isolatesExternalMcp).toBe(false);
  });
});
