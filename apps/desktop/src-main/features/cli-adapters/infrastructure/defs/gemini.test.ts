/**
 * Tests for Gemini adapter's mode-aware `buildExtraArgs` (--approval-mode) and
 * that `buildArgs` no longer hardcodes the deprecated `--yolo`.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { geminiAgentDef } from './gemini';
import { agentCapabilities } from '../detection/capabilities';
import type { AgentExtraArgsOptions } from '../../domain/runtime-agent-def';
import { buildDefaultCapabilities } from '../../../../../shared/domain/run-capabilities';
import type { RunId } from '../../../../../shared/domain/agent';
import type { RunMode } from '../../../../../shared/domain/run-capabilities';

const RID = 'rid' as RunId;

function extraArgs(mode?: RunMode): string[] {
  const fn = geminiAgentDef.buildExtraArgs;
  if (!fn) throw new Error('Gemini adapter is missing buildExtraArgs');
  const opts: AgentExtraArgsOptions = mode
    ? { systemPrompt: 's', capabilities: buildDefaultCapabilities(RID, mode) }
    : { systemPrompt: 's' };
  return fn(opts);
}

describe('Gemini buildExtraArgs — mode-aware approval', () => {
  it('plan → --approval-mode plan (read-only)', () => {
    expect(extraArgs('plan')).toEqual(['--approval-mode', 'plan']);
  });

  it('apply → --approval-mode yolo (interim)', () => {
    expect(extraArgs('apply')).toEqual(['--approval-mode', 'yolo']);
  });

  it('apply-yolo → --approval-mode yolo', () => {
    expect(extraArgs('apply-yolo')).toEqual(['--approval-mode', 'yolo']);
  });

  it('no capabilities → apply default (yolo)', () => {
    expect(extraArgs()).toEqual(['--approval-mode', 'yolo']);
  });
});

describe('Gemini buildArgs — no hardcoded --yolo', () => {
  it('does not include the deprecated --yolo flag', () => {
    const args = geminiAgentDef.buildArgs('p', [], [], {});
    expect(args).not.toContain('--yolo');
    expect(args.slice(0, 2)).toEqual(['--output-format', 'stream-json']);
  });
});

describe('Gemini buildArgs — whole-workspace --include-directories (S-19 F2.2)', () => {
  afterEach(() => agentCapabilities.clear());

  it('appends --include-directories when the capability is detected', () => {
    agentCapabilities.set('gemini', { includeDirs: true });
    const args = geminiAgentDef.buildArgs('p', [], ['/ws'], {});
    const i = args.indexOf('--include-directories');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe('/ws');
  });

  it('joins multiple dirs with a comma', () => {
    agentCapabilities.set('gemini', { includeDirs: true });
    const args = geminiAgentDef.buildArgs('p', [], ['/ws/a', '/ws/b'], {});
    expect(args[args.indexOf('--include-directories') + 1]).toBe('/ws/a,/ws/b');
  });

  it('omits the flag when the capability is NOT detected (older build)', () => {
    agentCapabilities.set('gemini', { includeDirs: false });
    const args = geminiAgentDef.buildArgs('p', [], ['/ws'], {});
    expect(args).not.toContain('--include-directories');
  });

  it('omits the flag when there are no extra dirs', () => {
    agentCapabilities.set('gemini', { includeDirs: true });
    const args = geminiAgentDef.buildArgs('p', [], [], {});
    expect(args).not.toContain('--include-directories');
  });
});

describe('Gemini continuity (S-19 F0)', () => {
  it('opts into transcript replay (no clean CLI resume handle)', () => {
    expect(geminiAgentDef.continuity).toBe('replay');
  });

  it('does not define buildResumeArgs (replay agents never resume natively)', () => {
    expect(geminiAgentDef.buildResumeArgs).toBeUndefined();
  });
});
