/**
 * Tests for the Qoder adapter promoted to a structured (Tier-1) agent:
 * stream-json invocation, image attachments, and mode-aware --permission-mode.
 */
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { qoderAgentDef } from './qoder';
import type { AgentExtraArgsOptions } from '../../domain/runtime-agent-def';
import { buildDefaultCapabilities } from '../../../../../shared/domain/run-capabilities';
import type { RunId } from '../../../../../shared/domain/agent';
import type { RunMode } from '../../../../../shared/domain/run-capabilities';

const RID = 'rid' as RunId;

function extraArgs(mode?: RunMode): string[] {
  const fn = qoderAgentDef.buildExtraArgs;
  if (!fn) throw new Error('qoder adapter is missing buildExtraArgs');
  const opts: AgentExtraArgsOptions = mode
    ? { systemPrompt: 's', capabilities: buildDefaultCapabilities(RID, mode) }
    : { systemPrompt: 's' };
  return fn(opts);
}

describe('qoder def — structured (Tier-1) agent', () => {
  it('streams JSONL via the dedicated qoder parser', () => {
    expect(qoderAgentDef.streamFormat).toBe('json-event-stream');
    expect(qoderAgentDef.eventParser).toBe('qoder');
    expect(qoderAgentDef.applicability).toBe('direct');
    expect(qoderAgentDef.supportsImagePaths).toBe(true);
  });

  it('buildArgs uses -p --output-format stream-json with no hardcoded permission flag', () => {
    const args = qoderAgentDef.buildArgs('p', [], [], {}, {});
    expect(args).toEqual(['-p', '--output-format', 'stream-json']);
  });

  it('adds -w from cwd, --add-dir for absolute dirs and --attachment for absolute images', () => {
    const dir = path.resolve('extra-dir');
    const img = path.resolve('shot.png');
    const args = qoderAgentDef.buildArgs('p', [img], [dir], { model: 'auto' }, { cwd: '/proj' });
    expect(args).toContain('-w');
    expect(args[args.indexOf('-w') + 1]).toBe('/proj');
    expect(args[args.indexOf('--add-dir') + 1]).toBe(dir);
    expect(args[args.indexOf('--attachment') + 1]).toBe(img);
    expect(args).toContain('--model');
  });
});

describe('qoder buildExtraArgs — mode-aware --permission-mode', () => {
  it('plan → --permission-mode plan', () => {
    expect(extraArgs('plan')).toEqual(['--permission-mode', 'plan']);
  });
  it('apply → --permission-mode accept_edits', () => {
    expect(extraArgs('apply')).toEqual(['--permission-mode', 'accept_edits']);
  });
  it('apply-yolo → --permission-mode bypass_permissions', () => {
    expect(extraArgs('apply-yolo')).toEqual(['--permission-mode', 'bypass_permissions']);
  });
});
