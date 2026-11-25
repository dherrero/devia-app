/**
 * Tests for the pi adapter def (verified against pi 1.3.0): `--mode rpc`
 * invocation (no prompt in argv), native resume, system prompt by file and
 * plan-mode tool exclusion.
 */
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { parsePiModels, piAgentDef } from './pi';
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
  });

  it('gives the writing tools back outside plan mode, because pi keeps the plan-mode selection in a resumed session', () => {
    for (const mode of ['apply', 'apply-yolo'] as const) {
      expect(piAgentDef.buildExtraArgs?.({ systemPrompt: '', capabilities: buildDefaultCapabilities('r1' as RunId, mode) })).toEqual(['--tools', '+bash,+edit,+write']);
    }
  });
});

describe('pi model discovery', () => {
  const TABLE = [
    'provider    model                                               context  max-out  thinking  images',
    'openai      gpt-5                                               400K     128K     yes       yes   ',
    'openrouter  ~anthropic/claude-sonnet-latest                     1M       128K     yes       yes   ',
    'openrouter  ~anthropic/claude-sonnet-latest                     1M       128K     yes       yes   ',
    '',
  ].join('\n');

  it('asks pi for the models of the providers it has credentials for', () => {
    expect(piAgentDef.listModels?.args).toEqual(['--list-models']);
    expect(piAgentDef.listModels?.parse).toBe(parsePiModels);
  });

  it('turns the table into provider/model ids, keeping the default option first and skipping the header and duplicates', () => {
    expect(parsePiModels(TABLE)).toEqual([
      { id: 'default', label: 'Default (CLI config)' },
      { id: 'openai/gpt-5', label: 'gpt-5 (openai)' },
      { id: 'openrouter/~anthropic/claude-sonnet-latest', label: '~anthropic/claude-sonnet-latest (openrouter)' },
    ]);
  });

  it('returns nothing for output that is not the table, so detection falls back to the built-in list', () => {
    expect(parsePiModels('')).toEqual([]);
    expect(parsePiModels('No models available. Set up authentication first.\n')).toEqual([]);
  });
});
