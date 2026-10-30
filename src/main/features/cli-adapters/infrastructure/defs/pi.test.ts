/**
 * Tests for the pi adapter def (verified against pi 1.3.0): `--mode rpc`
 * invocation (no prompt in argv), native resume, system prompt by file and
 * plan-mode tool exclusion.
 */
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { piAgentDef } from './pi';
import { buildDefaultCapabilities } from '../../../../../shared/domain/run-capabilities';
import type { RunId } from '../../../../../shared/domain/agent';

describe('pi def', () => {
  it('resumes natively with --session-id', () => {
    expect(piAgentDef.continuity).toBe('native');
    expect(piAgentDef.buildResumeArgs?.('01a1-abc')).toEqual(['--session-id', '01a1-abc']);
  });

  it('spawns `pi --mode rpc` as a pi-rpc agent (no prompt in argv)', () => {
    const args = piAgentDef.buildArgs('the prompt', [], [], {});
    expect(args).toEqual(['--mode', 'rpc']);
    expect(args).not.toContain('the prompt');
    expect(piAgentDef.streamFormat).toBe('pi-rpc');
  });

  it('passes --model and --thinking when set', () => {
    const args = piAgentDef.buildArgs('p', [], [], { model: 'anthropic/claude-sonnet-4-5', reasoning: 'high' });
    expect(args).toEqual(['--mode', 'rpc', '--model', 'anthropic/claude-sonnet-4-5', '--thinking', 'high']);
  });

  it('does not pass extra dirs as system prompt text (pi has no sandbox flag)', () => {
    const args = piAgentDef.buildArgs('p', [], [path.resolve('skills')], {});
    expect(args).not.toContain('--append-system-prompt');
  });

  it('delivers the Devia system prompt as a file', () => {
    expect(piAgentDef.systemPromptStrategy).toBe('argv-file');
    expect(piAgentDef.buildSystemPromptFileArgs?.('/tmp/s.md')).toEqual(['--append-system-prompt', '/tmp/s.md']);
  });

  it('limits plan mode to the read-only built-ins (no bash, no writers)', () => {
    const plan = piAgentDef.buildExtraArgs?.({ systemPrompt: '', capabilities: buildDefaultCapabilities('r1' as RunId, 'plan') });
    expect(plan).toEqual(['--tools', 'read,grep,find,ls,mcp__*']);
    expect(piAgentDef.buildExtraArgs?.({ systemPrompt: '', capabilities: buildDefaultCapabilities('r1' as RunId, 'apply') })).toEqual([]);
  });
});
