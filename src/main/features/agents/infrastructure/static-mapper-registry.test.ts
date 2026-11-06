import { describe, expect, it } from 'vitest';
import type { RuntimeAgentDef } from '../../cli-adapters/domain/runtime-agent-def';
import { AGENT_DEFS } from '../../cli-adapters/infrastructure/registry';
import { AcpMapper } from '../acp/mapper';
import { ClaudeMapper } from '../claude/mapper';
import { OpencodeMapper } from '../opencode/mapper';
import { PiMapper } from '../pi/mapper';
import { LegacyMapper } from './legacy/legacy-mapper';
import { StaticMapperRegistry } from './static-mapper-registry';

const deps = { nativeMcp: { deliver: () => ({ file: null, deliveredServerIds: [] }) } };
const registry = (): StaticMapperRegistry => new StaticMapperRegistry(deps);
const def = (id: string): RuntimeAgentDef => {
  const found = AGENT_DEFS.find((d) => d.id === id);
  if (!found) throw new Error(`no def ${id}`);
  return found;
};

describe('StaticMapperRegistry', () => {
  it('claude, pi and opencode still get their dedicated mappers', () => {
    const r = registry();
    expect(r.forDef(def('claude'))).toBeInstanceOf(ClaudeMapper);
    expect(r.forDef(def('pi'))).toBeInstanceOf(PiMapper);
    expect(r.forDef(def('opencode'))).toBeInstanceOf(OpencodeMapper);
  });

  it('kimi and hermes get the AcpMapper', () => {
    const r = registry();
    expect(r.forDef(def('kimi'))).toBeInstanceOf(AcpMapper);
    expect(r.forDef(def('hermes'))).toBeInstanceOf(AcpMapper);
  });

  it('every other built-in def gets a LegacyMapper', () => {
    const r = registry();
    const rest = AGENT_DEFS.filter((d) => !['claude', 'pi', 'opencode', 'kimi', 'hermes'].includes(d.id));
    expect(rest.length).toBeGreaterThan(0);
    for (const d of rest) expect(r.forDef(d), d.id).toBeInstanceOf(LegacyMapper);
  });

  it('an unknown user def with the kimi id but another stream format stays on LegacyMapper', () => {
    const impostor: RuntimeAgentDef = { ...def('kimi'), streamFormat: 'plain' };
    expect(registry().forDef(impostor)).toBeInstanceOf(LegacyMapper);
  });

  it('a def without a profile never becomes an AcpMapper even with the acp-json-rpc format', () => {
    const custom: RuntimeAgentDef = { ...def('kimi'), id: 'my-acp-agent', streamFormat: 'acp-json-rpc' };
    expect(registry().forDef(custom)).toBeInstanceOf(LegacyMapper);
  });

  it('mappers are cached per def instance', () => {
    const r = registry();
    expect(r.forDef(def('kimi'))).toBe(r.forDef(def('kimi')));
    const copy = { ...def('kimi') };
    expect(r.forDef(copy)).not.toBe(r.forDef(def('kimi')));
  });
});

describe('StaticMapperRegistry — user ACP defs', () => {
  const userDef = (over: Partial<RuntimeAgentDef> = {}): RuntimeAgentDef => ({
    ...def('kimi'),
    id: 'my-agent',
    bin: 'my-acp-agent',
    acp: { args: ['acp'], continuity: 'replay', planEnforcement: 'none', modeIds: {} },
    ...over,
  });

  it('gives a user ACP def with a valid acp block an AcpMapper', () => {
    expect(registry().forDef(userDef())).toBeInstanceOf(AcpMapper);
  });

  it('a user def with an invalid acp block or another stream format stays on LegacyMapper', () => {
    expect(registry().forDef(userDef({ acp: { args: [], continuity: 'replay', planEnforcement: 'none', modeIds: {} } }))).toBeInstanceOf(AcpMapper);
    expect(registry().forDef(userDef({ streamFormat: 'plain' }))).toBeInstanceOf(LegacyMapper);
    const broken = userDef({ acp: { args: 'acp' } as never });
    expect(registry().forDef(broken)).toBeInstanceOf(LegacyMapper);
  });

  it('a user acp block cannot take over claude, pi or opencode', () => {
    expect(registry().forDef({ ...def('claude'), acp: { args: ['x'], continuity: 'replay', planEnforcement: 'none', modeIds: {} } })).toBeInstanceOf(ClaudeMapper);
    expect(registry().forDef({ ...def('pi'), acp: { args: ['x'], continuity: 'replay', planEnforcement: 'none', modeIds: {} } })).toBeInstanceOf(PiMapper);
  });

  it('a user def carrying a built-in ACP id still uses the built-in profile', () => {
    const mapper = registry().forDef({ ...def('kimi'), acp: { args: ['--evil'], continuity: 'native', planEnforcement: 'agent-mode', modeIds: {} } });
    expect(mapper).toBeInstanceOf(AcpMapper);
    const prepared = (mapper as AcpMapper).prepareRun(
      { runId: 'r', envOverrides: {}, model: null } as never,
      '',
      { mcpServerIds: [], skills: 'none', subagents: 'none', notices: [] },
    );
    expect(prepared.ok && prepared.run.args).toEqual(['acp']);
  });
});
