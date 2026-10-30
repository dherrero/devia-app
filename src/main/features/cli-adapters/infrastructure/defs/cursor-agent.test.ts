/**
 * Tests for the cursor-agent adapter: the corrected headless invocation
 * (`--print --output-format stream-json`, not the legacy `chat --json`) and
 * the mode-aware `buildExtraArgs`.
 */
import { describe, it, expect } from 'vitest';
import { cursorAgentDef, parseCursorAgentModels } from './cursor-agent';
import type { AgentExtraArgsOptions } from '../../domain/runtime-agent-def';
import { buildDefaultCapabilities } from '../../../../../shared/domain/run-capabilities';
import type { RunId } from '../../../../../shared/domain/agent';
import type { RunMode } from '../../../../../shared/domain/run-capabilities';

const RID = 'rid' as RunId;

function extraArgs(mode?: RunMode): string[] {
  const fn = cursorAgentDef.buildExtraArgs;
  if (!fn) throw new Error('cursor-agent adapter is missing buildExtraArgs');
  const opts: AgentExtraArgsOptions = mode
    ? { systemPrompt: 's', capabilities: buildDefaultCapabilities(RID, mode) }
    : { systemPrompt: 's' };
  return fn(opts);
}

describe('cursor-agent buildArgs — modern headless invocation', () => {
  it('uses --print --output-format stream-json (not the legacy chat --json)', () => {
    const args = cursorAgentDef.buildArgs('p', [], [], {}, {});
    expect(args).toContain('--print');
    expect(args).toContain('--output-format');
    expect(args).toContain('stream-json');
    expect(args).toContain('--trust');
    expect(args).not.toContain('chat');
    expect(args).not.toContain('--json');
  });

  it('adds --workspace from runtimeContext.cwd', () => {
    const args = cursorAgentDef.buildArgs('p', [], [], {}, { cwd: '/proj' });
    const i = args.indexOf('--workspace');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe('/proj');
  });
});

describe('cursor-agent buildExtraArgs — mode-aware permission', () => {
  it('plan → --mode plan (read-only)', () => {
    expect(extraArgs('plan')).toEqual(['--mode', 'plan']);
  });
  it('apply → --force', () => {
    expect(extraArgs('apply')).toEqual(['--force']);
  });
  it('apply-yolo → --force', () => {
    expect(extraArgs('apply-yolo')).toEqual(['--force']);
  });
});

describe('parseCursorAgentModels', () => {
  it('parses ids and prepends the default option', () => {
    const models = parseCursorAgentModels('sonnet-4\ngpt-5\n');
    expect(models?.map((m) => m.id)).toEqual(['default', 'sonnet-4', 'gpt-5']);
  });
  it('returns null for empty output', () => {
    expect(parseCursorAgentModels('   ')).toBeNull();
  });
});
