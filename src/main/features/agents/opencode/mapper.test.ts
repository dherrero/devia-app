import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { McpServerConfig } from '../../../../shared/domain/mcp';
import { opencodeAgentDef } from '../../cli-adapters/infrastructure/defs/opencode';
import { makeRunPlan } from '../testing/make-run-plan';
import { canonicalOpencodeToolName, OpencodeMapper } from './mapper';

let project: string;
let deviaDir: string;
let home: string;
beforeEach(() => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'devia-oc-map-'));
  deviaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devia-oc-dd-'));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'devia-oc-home-'));
});
afterEach(() => {
  for (const d of [project, deviaDir, home]) fs.rmSync(d, { recursive: true, force: true });
});

const server = (id: string, env?: Record<string, string>): McpServerConfig =>
  ({ id, name: id, command: 'node', args: [`${id}.js`], enabled: true, ...(env && { env }) });
const mapper = (): OpencodeMapper => new OpencodeMapper(opencodeAgentDef, { nativeMcp: { deliver: () => ({ file: null, deliveredServerIds: [] }) } }, () => home);
const planWith = (overrides = {}) => makeRunPlan({
  agentId: 'opencode', cwd: project, deviaDir, prompt: 'hola',
  harness: { mcp: { devia: [server('devia-kanban'), server('devia-ui')], user: [server('github', { GITHUB_TOKEN: 'secret' })] }, skills: [], subagents: [], isolateExternalMcp: true },
  ...overrides,
});
const prepare = (m: OpencodeMapper, plan = planWith()) => {
  const prepared = m.prepareRun(plan, 'SYS', m.resolveDelivery(plan));
  if (!prepared.ok) throw new Error(prepared.error);
  return prepared.run;
};

describe('OpencodeMapper', () => {
  it('passes user + Devia servers in a per-run OPENCODE_CONFIG — the repo is not touched', () => {
    const run = prepare(mapper());
    const file = run.agentEnv?.['OPENCODE_CONFIG'] ?? '';
    expect(file.startsWith(path.join(deviaDir, 'tmp'))).toBe(true);
    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(Object.keys(config.mcp)).toEqual(['github', 'devia-kanban', 'devia-ui']);
    expect(config.mcp.github).toEqual({ type: 'local', command: ['node', 'github.js'], environment: { GITHUB_TOKEN: 'secret' } });
    expect(fs.existsSync(path.join(project, 'opencode.json'))).toBe(false);
    run.cleanup();
    expect(fs.existsSync(file)).toBe(false);
  });

  it('turns Devia sub-agents into native OpenCode sub-agents', () => {
    const def = path.join(project, 'reviewer.md');
    fs.writeFileSync(def, '---\nname: reviewer\ndescription: Reviews\nagents: [claude]\n---\nBe strict.');
    const run = prepare(mapper(), planWith({
      harness: { mcp: { devia: [], user: [] }, skills: [], subagents: [{ name: 'reviewer', description: 'Reviews', file: def }], isolateExternalMcp: false },
    }));
    const config = JSON.parse(fs.readFileSync(run.agentEnv?.['OPENCODE_CONFIG'] ?? '', 'utf8'));
    expect(config.agent).toEqual({ reviewer: { description: 'Reviews', mode: 'subagent', prompt: 'Be strict.' } });
  });

  it('retires stale Devia entries from the project opencode.json, keeping the user\'s', () => {
    const file = path.join(project, 'opencode.json');
    fs.writeFileSync(file, JSON.stringify({ mcp: {
      'devia-ui': { type: 'local', command: ['old'], __devia_managed: 'devia-ui' },
      mine: { type: 'local', command: ['mine'] },
    } }));
    prepare(mapper());
    expect(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).mcp)).toEqual(['mine']);
  });

  it('resumes natively and keeps the system prompt on stdin', () => {
    const run = prepare(mapper(), planWith({ resumeSessionId: 'ses_1' }));
    expect(run.args.slice(run.args.indexOf('--session'), run.args.indexOf('--session') + 2)).toEqual(['--session', 'ses_1']);
    expect(run.stdin).toEqual({ kind: 'text', payload: '[System]\nSYS\n\n[User]\nhola' });
  });

  it('makes OpenCode MCP tool names canonical', () => {
    const ids = ['devia-ui', 'devia-memory', 'e2e-echo'];
    expect(canonicalOpencodeToolName('devia-ui_devia_todo', ids)).toBe('mcp__devia-ui__devia_todo');
    expect(canonicalOpencodeToolName('e2e-echo_echo_token', ids)).toBe('mcp__e2e-echo__echo_token');
    expect(canonicalOpencodeToolName('bash', ids)).toBe('bash');
  });
});
