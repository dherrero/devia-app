/**
 * Tests for Codex adapter's mode-aware `buildExtraArgs` (sandbox/approval) and
 * that `buildArgs` no longer hardcodes a sandbox flag.
 */
import { describe, it, expect } from 'vitest';
import { codexAgentDef } from './codex';
import type { AgentExtraArgsOptions } from '../../domain/runtime-agent-def';
import { buildDefaultCapabilities } from '../../../../../shared/domain/run-capabilities';
import type { RunId } from '../../../../../shared/domain/agent';
import type { RunMode } from '../../../../../shared/domain/run-capabilities';

const RID = 'rid' as RunId;

function extraArgs(mode?: RunMode, resumeSessionId?: string): string[] {
  const fn = codexAgentDef.buildExtraArgs;
  if (!fn) throw new Error('Codex adapter is missing buildExtraArgs');
  const opts: AgentExtraArgsOptions = {
    systemPrompt: 's',
    ...(mode && { capabilities: buildDefaultCapabilities(RID, mode) }),
    ...(resumeSessionId !== undefined && { resumeSessionId }),
  };
  return fn(opts);
}

describe('Codex buildExtraArgs — mode-aware sandbox', () => {
  it('plan → danger-full-access while codex#16685 cancels MCP under managed sandboxes', () => {
    // The SDD planner NEEDS the devia-kanban/devia-memory MCP tools, and codex
    // exec cancels every MCP call under read-only/workspace-write profiles.
    expect(extraArgs('plan')).toEqual(['--sandbox', 'danger-full-access']);
  });

  it('apply-yolo → bypass approvals and sandbox', () => {
    expect(extraArgs('apply-yolo')).toEqual(['--dangerously-bypass-approvals-and-sandbox']);
  });

  it('apply → a sandbox flag (never read-only/bypass, never --ask-for-approval)', () => {
    const args = extraArgs('apply');
    expect(args).toContain('--sandbox');
    expect(args).not.toContain('--ask-for-approval');
    expect(args).not.toContain('read-only');
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
  });

  it('no capabilities → apply default', () => {
    const args = extraArgs();
    expect(args).toContain('--sandbox');
    expect(args).not.toContain('--ask-for-approval');
    expect(args).not.toContain('read-only');
  });
});

describe('Codex buildArgs — no hardcoded sandbox', () => {
  it('does not include a --sandbox flag and keeps the exec base', () => {
    const args = codexAgentDef.buildArgs('p', [], [], {}, {});
    expect(args).not.toContain('--sandbox');
    expect(args.slice(0, 3)).toEqual(['exec', '--json', '--skip-git-repo-check']);
  });
});

describe('Codex resume — `exec resume <id>` session continuity', () => {
  it('buildArgs inserts the resume subcommand right after exec, with `-` for stdin', () => {
    const args = codexAgentDef.buildArgs('p', [], [], {}, { cwd: '/w', resumeSessionId: 'thread-1' });
    expect(args.slice(0, 6)).toEqual(['exec', 'resume', 'thread-1', '-', '--json', '--skip-git-repo-check']);
  });

  it('buildArgs omits -C and --add-dir on resume (rejected by the subcommand)', () => {
    const args = codexAgentDef.buildArgs('p', [], ['/extra'], {}, { cwd: '/w', resumeSessionId: 'thread-1' });
    expect(args).not.toContain('-C');
    expect(args).not.toContain('--add-dir');
  });

  it('buildArgs keeps model + reasoning flags on resume', () => {
    const args = codexAgentDef.buildArgs(
      'p', [], [], { model: 'gpt-5.5', reasoning: 'high' }, { resumeSessionId: 'thread-1' },
    );
    expect(args).toContain('--model');
    expect(args).toContain('gpt-5.5');
    expect(args.join(' ')).toContain('model_reasoning_effort="high"');
  });

  it('buildArgs without resumeSessionId keeps -C for the cwd', () => {
    const args = codexAgentDef.buildArgs('p', [], [], {}, { cwd: '/w' });
    expect(args).toContain('-C');
    expect(args).toContain('/w');
  });

  it('buildExtraArgs plan on resume → -c sandbox_mode override (no --sandbox)', () => {
    const args = extraArgs('plan', 'thread-1');
    expect(args).toEqual(['-c', 'sandbox_mode="danger-full-access"']);
  });

  it('buildExtraArgs apply on resume → -c sandbox_mode override (no --sandbox)', () => {
    const args = extraArgs('apply', 'thread-1');
    expect(args).not.toContain('--sandbox');
    expect(args.join(' ')).toContain('sandbox_mode=');
  });

  it('buildExtraArgs apply-yolo on resume keeps the bypass flag (accepted by resume)', () => {
    expect(extraArgs('apply-yolo', 'thread-1')).toEqual(['--dangerously-bypass-approvals-and-sandbox']);
  });
});
