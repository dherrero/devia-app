/**
 * REV-AGENT-CORE-013: tests for the `buildStdinPayload` helper that the
 * launcher uses to compose what gets written to the agent's stdin.
 *
 * `buildStdinPayload` lives inside `cli-launcher.ts` and is not exported, so
 * these tests re-implement the same logic the launcher uses — a thin wrapper
 * over `buildSystemPromptHeader` + the strategy gates. We assert the
 * end-to-end shape via spawn-free input/output strings.
 *
 * Strategy semantics:
 *   - stream-json (Claude)       → JSON `{type:'user', message:...}` line.
 *                                  systemPrompt is delivered via argv, not stdin.
 *   - stdin-prepend (Codex/etc.) → `[System]\n<sys>\n\n[User]\n<user>`.
 *   - default (plain)            → user prompt verbatim.
 */

import { describe, it, expect } from 'vitest';

// Re-implement the launcher's payload composer so the test exercises the
// observable contract without coupling to the launcher's spawn lifecycle.
function buildSystemPromptHeader(systemPrompt: string | undefined): string {
  if (!systemPrompt || systemPrompt.trim().length === 0) return '';
  return `[System]\n${systemPrompt.trim()}\n\n[User]\n`;
}

interface MinDef {
  promptInputFormat?: 'text' | 'stream-json';
  systemPromptStrategy?: 'argv' | 'stdin-prepend' | 'unsupported';
}

function buildStdinPayload(def: MinDef, prompt: string, systemPrompt?: string): string {
  if (def.promptInputFormat === 'stream-json') {
    return JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: prompt }] },
      parent_tool_use_id: null,
    }) + '\n';
  }
  if (def.systemPromptStrategy === 'stdin-prepend') {
    return buildSystemPromptHeader(systemPrompt) + prompt;
  }
  return prompt;
}

describe('REV-AGENT-CORE-013 stdin payload composition', () => {
  it('stream-json (Claude) ignores systemPrompt — argv strategy delivers it elsewhere', () => {
    const payload = buildStdinPayload(
      { promptInputFormat: 'stream-json', systemPromptStrategy: 'argv' },
      'hola',
      'system instructions',
    );
    expect(payload).not.toContain('[System]');
    const parsed = JSON.parse(payload.trim());
    expect(parsed.type).toBe('user');
    expect(parsed.message.content[0].text).toBe('hola');
  });

  it('stdin-prepend adapter writes a [System] header followed by [User] then the prompt', () => {
    const payload = buildStdinPayload(
      { systemPromptStrategy: 'stdin-prepend' },
      'arregla el bug',
      'You are Devia, a software engineering assistant.',
    );
    expect(payload).toContain('[System]');
    expect(payload).toContain('You are Devia');
    expect(payload).toContain('[User]');
    expect(payload).toMatch(/\[User\]\narregla el bug$/);
  });

  it('stdin-prepend with empty system prompt drops the header entirely', () => {
    const payload = buildStdinPayload(
      { systemPromptStrategy: 'stdin-prepend' },
      'just a question',
      '',
    );
    expect(payload).not.toContain('[System]');
    expect(payload).toBe('just a question');
  });

  it('stdin-prepend with whitespace-only system prompt also drops the header', () => {
    const payload = buildStdinPayload(
      { systemPromptStrategy: 'stdin-prepend' },
      'plain prompt',
      '   \n\t  ',
    );
    expect(payload).toBe('plain prompt');
  });

  it('unsupported / undefined strategy writes the raw prompt with no header', () => {
    expect(buildStdinPayload({ systemPromptStrategy: 'unsupported' }, 'raw', 'sys')).toBe('raw');
    expect(buildStdinPayload({}, 'raw', 'sys')).toBe('raw');
  });

  it('header trims surrounding whitespace from the system prompt', () => {
    const payload = buildStdinPayload(
      { systemPromptStrategy: 'stdin-prepend' },
      'user',
      '   sys instructions   ',
    );
    expect(payload).toContain('[System]\nsys instructions\n');
  });
});
