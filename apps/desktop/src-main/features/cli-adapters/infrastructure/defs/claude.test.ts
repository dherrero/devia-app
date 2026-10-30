/**
 * REV-AGENT-CORE-006: tests for Claude adapter's mode-aware `buildExtraArgs`.
 *
 * Covers the argv shape produced for each mode (plan / apply / apply-yolo)
 * including the interplay with the per-run `RunCapabilities` denylist.
 */

import { describe, it, expect } from 'vitest';
import { claudeAgentDef } from './claude';
import type { AgentExtraArgsOptions } from '../../domain/runtime-agent-def';
import { buildDefaultCapabilities } from '../../../../../shared/domain/run-capabilities';
import type { RunId } from '../../../../../shared/domain/agent';

function buildArgs(opts: AgentExtraArgsOptions): string[] {
  const buildExtraArgs = claudeAgentDef.buildExtraArgs;
  if (!buildExtraArgs) throw new Error('Claude adapter is missing buildExtraArgs');
  return buildExtraArgs(opts);
}

const RID = 'rid' as RunId;

describe('Claude buildExtraArgs — mode-aware argv (REV-AGENT-CORE-006)', () => {
  it('does not expose the devia-ui rendezvous env as a user-settable override', () => {
    // Its mapper sets it as trusted agentEnv (S-30); the user never should.
    expect(claudeAgentDef.envOverrideKeys).not.toContain('DEVIA_UI_DIR');
    expect(claudeAgentDef.envOverrideKeys).not.toContain('DEVIA_UI_TOOL_TIMEOUT_MS');
  });

  it('plan mode → --permission-mode default + denylist with Edit/Write/MultiEdit/Bash', () => {
    const capabilities = buildDefaultCapabilities(RID, 'plan', {
      defaultDisallowedTools: ['WebSearch', 'WebFetch'],
    });
    const args = buildArgs({ systemPrompt: 'sys', capabilities });

    expect(args).toContain('--permission-mode');
    expect(args).toContain('default');

    const disallowIdx = args.indexOf('--disallowedTools');
    expect(disallowIdx).toBeGreaterThanOrEqual(0);
    const disallowList = (args[disallowIdx + 1] ?? '').split(',');
    expect(disallowList).toEqual(expect.arrayContaining(['Edit', 'Write', 'MultiEdit', 'Bash']));
    expect(disallowList).toEqual(expect.arrayContaining(['WebSearch', 'WebFetch']));
  });

  it('apply mode → --permission-mode acceptEdits (existing default behaviour)', () => {
    const capabilities = buildDefaultCapabilities(RID, 'apply', {
      defaultDisallowedTools: ['WebSearch', 'WebFetch'],
    });
    const args = buildArgs({ systemPrompt: 'sys', capabilities });

    expect(args).toContain('--permission-mode');
    expect(args).toContain('acceptEdits');
    expect(args).not.toContain('--dangerously-skip-permissions');
  });

  it('apply-yolo mode → --dangerously-skip-permissions', () => {
    const capabilities = buildDefaultCapabilities(RID, 'apply-yolo', {
      defaultDisallowedTools: ['WebSearch', 'WebFetch'],
    });
    const args = buildArgs({ systemPrompt: 'sys', capabilities });

    expect(args).toContain('--dangerously-skip-permissions');
    expect(args).not.toContain('--permission-mode');
  });

  it('no capabilities → apply mode (default)', () => {
    const args = buildArgs({ systemPrompt: 'sys' });
    expect(args).toContain('--permission-mode');
    expect(args).toContain('acceptEdits');
  });

  it('no capabilities → falls back to the adapter default denylist', () => {
    const args = buildArgs({ systemPrompt: 'sys' });
    const disallowIdx = args.indexOf('--disallowedTools');
    const disallowList = (args[disallowIdx + 1] ?? '').split(',');
    expect(disallowList).toEqual(expect.arrayContaining(['WebSearch', 'WebFetch']));
  });
});
