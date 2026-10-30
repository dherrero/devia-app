/**
 * REV-AGENT-CORE-010: dispatcher-level tests for `probeAgentAuthStatus`.
 *
 * Asserts that the central dispatcher correctly routes to / falls back from
 * `def.authProbe` without touching child_process — these tests construct
 * fake defs with stub probes so they have no dependency on the Claude probe
 * mock setup used in `auth-probe.test.ts`.
 */
import { describe, it, expect, vi } from 'vitest';
import { probeAgentAuthStatus } from './auth-probe';
import type { AuthProbeResult, RuntimeAgentDef } from '../../domain/runtime-agent-def';

function fakeDef(id: string, authProbe?: RuntimeAgentDef['authProbe']): RuntimeAgentDef {
  const base: RuntimeAgentDef = {
    id,
    name: id,
    bin: id,
    versionArgs: ['--version'],
    fallbackModels: [],
    buildArgs: () => [],
    streamFormat: 'plain',
    systemPromptStrategy: 'unsupported',
  };
  if (authProbe) base.authProbe = authProbe;
  return base;
}

describe('REV-AGENT-CORE-010 probeAgentAuthStatus dispatcher', () => {
  it('returns "unknown" when def is undefined', async () => {
    const r = await probeAgentAuthStatus(undefined, '/bin/foo', {});
    expect(r).toEqual({ status: 'unknown' });
  });

  it('returns "unknown" when def has no authProbe', async () => {
    const r = await probeAgentAuthStatus(fakeDef('no-probe'), '/bin/foo', {});
    expect(r).toEqual({ status: 'unknown' });
  });

  it('propagates whatever the def.authProbe returns', async () => {
    const probe = vi.fn(async (): Promise<AuthProbeResult> => ({
      status: 'ok',
    }));
    const def = fakeDef('with-probe', probe);
    const r = await probeAgentAuthStatus(def, '/bin/with-probe', { FOO: 'bar' });
    expect(r).toEqual({ status: 'ok' });
    expect(probe).toHaveBeenCalledWith('/bin/with-probe', { FOO: 'bar' });
  });

  it('maps a thrown probe to "unknown" without propagating', async () => {
    const def = fakeDef('throws', async () => {
      throw new Error('boom');
    });
    const r = await probeAgentAuthStatus(def, '/bin/throws', {});
    expect(r).toEqual({ status: 'unknown' });
  });

  it('maps a probe returning null/undefined to "unknown"', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const def = fakeDef('null-result', (async () => null) as any);
    const r = await probeAgentAuthStatus(def, '/bin/null', {});
    expect(r).toEqual({ status: 'unknown' });
  });

  it('forwards "missing" with the probe-supplied message', async () => {
    const def = fakeDef('missing', async () => ({
      status: 'missing',
      message: 'Please log in.',
    }));
    const r = await probeAgentAuthStatus(def, '/bin/missing', {});
    expect(r.status).toBe('missing');
    expect(r.message).toBe('Please log in.');
  });
});
