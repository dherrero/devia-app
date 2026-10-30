/**
 * Tests for the GitHub Copilot CLI adapter: standalone `copilot` invocation
 * (JSONL, stdin prompt) and mode-aware `buildExtraArgs`.
 */
import { describe, it, expect } from 'vitest';
import { copilotAgentDef } from './copilot';
import type { AgentExtraArgsOptions } from '../../domain/runtime-agent-def';
import { buildDefaultCapabilities } from '../../../../../shared/domain/run-capabilities';
import type { RunId } from '../../../../../shared/domain/agent';
import type { RunMode } from '../../../../../shared/domain/run-capabilities';

const RID = 'rid' as RunId;

function extraArgs(mode?: RunMode): string[] {
  const fn = copilotAgentDef.buildExtraArgs;
  if (!fn) throw new Error('copilot adapter is missing buildExtraArgs');
  const opts: AgentExtraArgsOptions = mode
    ? { systemPrompt: 's', capabilities: buildDefaultCapabilities(RID, mode) }
    : { systemPrompt: 's' };
  return fn(opts);
}

describe('copilot def — standalone CLI', () => {
  it('targets the standalone `copilot` binary, not the gh extension', () => {
    expect(copilotAgentDef.bin).toBe('copilot');
    expect(copilotAgentDef.versionArgs).toEqual(['--version']);
  });

  it('buildArgs uses --output-format json, omits -p / chat / permission flags', () => {
    const args = copilotAgentDef.buildArgs('p', [], [], {});
    expect(args).toContain('--output-format');
    expect(args).toContain('json');
    expect(args).not.toContain('-p');
    expect(args).not.toContain('chat');
    expect(args).not.toContain('--allow-all-tools');
  });

  it('buildArgs maps extra allowed dirs to --add-dir', () => {
    const args = copilotAgentDef.buildArgs('p', [], ['/a', '/b'], {});
    const dirs = args.filter((_v, i) => args[i - 1] === '--add-dir');
    expect(dirs).toEqual(['/a', '/b']);
  });
});

describe('copilot buildExtraArgs — mode-aware (deny wins over allow-all)', () => {
  it('plan → allow-all-tools + deny write/shell (read-only)', () => {
    expect(extraArgs('plan')).toEqual(['--allow-all-tools', '--deny-tool', 'write', '--deny-tool', 'shell']);
  });
  it('apply → allow-all-tools + deny dangerous shell', () => {
    expect(extraArgs('apply')).toEqual(['--allow-all-tools', '--deny-tool', 'shell(rm:*)', '--deny-tool', 'shell(git push)']);
  });
  it('apply-yolo → --allow-all', () => {
    expect(extraArgs('apply-yolo')).toEqual(['--allow-all']);
  });
});
