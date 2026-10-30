/**
 * Tests for the Qwen Code adapter: stdin prompt delivery (stays plain) and
 * mode-aware approval flags.
 */
import { describe, it, expect } from 'vitest';
import { qwenAgentDef } from './qwen';
import type { AgentExtraArgsOptions } from '../../domain/runtime-agent-def';
import { buildDefaultCapabilities } from '../../../../../shared/domain/run-capabilities';
import type { RunId } from '../../../../../shared/domain/agent';
import type { RunMode } from '../../../../../shared/domain/run-capabilities';

const RID = 'rid' as RunId;

function extraArgs(mode?: RunMode): string[] {
  const fn = qwenAgentDef.buildExtraArgs;
  if (!fn) throw new Error('qwen adapter is missing buildExtraArgs');
  const opts: AgentExtraArgsOptions = mode
    ? { systemPrompt: 's', capabilities: buildDefaultCapabilities(RID, mode) }
    : { systemPrompt: 's' };
  return fn(opts);
}

describe('qwen def', () => {
  it('stays plain-text and delivers the prompt via stdin', () => {
    expect(qwenAgentDef.streamFormat).toBe('plain');
    expect(qwenAgentDef.promptViaStdin).toBe(true);
  });

  it('buildArgs carries no permission flag; adds --model only when set', () => {
    expect(qwenAgentDef.buildArgs('p', [], [], {})).toEqual([]);
    expect(qwenAgentDef.buildArgs('p', [], [], { model: 'qwen3-coder-plus' })).toEqual(['--model', 'qwen3-coder-plus']);
    expect(qwenAgentDef.buildArgs('p', [], [], {})).not.toContain('--yolo');
  });
});

describe('qwen buildExtraArgs — mode-aware', () => {
  it('plan → --approval-mode plan (read-only)', () => {
    expect(extraArgs('plan')).toEqual(['--approval-mode', 'plan']);
  });
  it('apply → --yolo', () => {
    expect(extraArgs('apply')).toEqual(['--yolo']);
  });
  it('apply-yolo → --yolo', () => {
    expect(extraArgs('apply-yolo')).toEqual(['--yolo']);
  });
});
