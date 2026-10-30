/**
 * Tests for OpenCode adapter's mode-aware `buildExtraArgs` (--agent / skip
 * permissions) and that `buildArgs` no longer hardcodes the permission flag.
 */
import { describe, it, expect } from 'vitest';
import { opencodeAgentDef } from './opencode';
import type { AgentExtraArgsOptions } from '../../domain/runtime-agent-def';
import { buildDefaultCapabilities } from '../../../../../shared/domain/run-capabilities';
import type { RunId } from '../../../../../shared/domain/agent';
import type { RunMode } from '../../../../../shared/domain/run-capabilities';

const RID = 'rid' as RunId;

function extraArgs(mode?: RunMode): string[] {
  const fn = opencodeAgentDef.buildExtraArgs;
  if (!fn) throw new Error('OpenCode adapter is missing buildExtraArgs');
  const opts: AgentExtraArgsOptions = mode
    ? { systemPrompt: 's', capabilities: buildDefaultCapabilities(RID, mode) }
    : { systemPrompt: 's' };
  return fn(opts);
}

describe('OpenCode buildExtraArgs — mode-aware permission', () => {
  it('plan → --agent plan (read-only built-in agent)', () => {
    expect(extraArgs('plan')).toEqual(['--agent', 'plan']);
  });

  it('apply → --dangerously-skip-permissions (interim)', () => {
    expect(extraArgs('apply')).toEqual(['--dangerously-skip-permissions']);
  });

  it('apply-yolo → --dangerously-skip-permissions', () => {
    expect(extraArgs('apply-yolo')).toEqual(['--dangerously-skip-permissions']);
  });

  it('no capabilities → apply default', () => {
    expect(extraArgs()).toEqual(['--dangerously-skip-permissions']);
  });
});

describe('OpenCode buildArgs — no hardcoded permission flag', () => {
  it('does not include --dangerously-skip-permissions', () => {
    const args = opencodeAgentDef.buildArgs('p', [], [], {});
    expect(args).not.toContain('--dangerously-skip-permissions');
    expect(args.slice(0, 3)).toEqual(['run', '--format', 'json']);
  });
});

describe('OpenCode continuity (S-30 T-351)', () => {
  it('resumes natively with run --session <id>', () => {
    expect(opencodeAgentDef.continuity).toBe('native');
    expect(opencodeAgentDef.buildResumeArgs?.('ses_1')).toEqual(['--session', 'ses_1']);
  });
});
