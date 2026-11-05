import { describe, it, expect } from 'vitest';
import { uiToolPublicName } from '../../../../shared/domain/ui-tools';
import {
  TURN_CONTEXT_PREAMBLE,
  hashTurnContext,
  renderTurnContext,
  sanitizeTurnContextTags,
  type TurnFacts,
} from './turn-context';

const desktop: TurnFacts = {
  channel: 'desktop',
  mode: 'apply',
  cwd: '/p',
  isolatedWorktree: false,
  uiTools: ['ask_user', 'todo'],
};

describe('renderTurnContext', () => {
  it('renders the open tag with source and priority attributes', () => {
    const block = renderTurnContext(desktop, []);
    expect(block.startsWith('<devia-turn-context source="devia" priority="binding">')).toBe(true);
    expect(block.endsWith('</devia-turn-context>')).toBe(true);
  });

  it('states the facts for a desktop apply run', () => {
    const block = renderTurnContext(desktop, []);
    expect(block).toContain('- Channel: Devia desktop app');
    expect(block).toContain('- Mode: apply');
    expect(block).toContain('- Working directory: /p');
    expect(block).toContain(
      `- Devia UI tools available this turn: ${uiToolPublicName('ask_user')}, ${uiToolPublicName('todo')}`,
    );
  });

  it('states Telegram, worktree and no tools', () => {
    const block = renderTurnContext(
      { channel: 'telegram', mode: 'plan', cwd: '/w', isolatedWorktree: true, uiTools: [] },
      [],
    );
    expect(block).toContain('- Channel: Telegram chat relay (the user reads on a phone and cannot see cards)');
    expect(block).toContain('- Mode: plan');
    expect(block).toContain('- Working directory: /w (isolated session worktree)');
    expect(block).toContain('- Devia UI tools available this turn: none');
  });

  it('appends the segments after the facts, in order, separated by a blank line', () => {
    const block = renderTurnContext(desktop, ['SEG-A', 'SEG-B']);
    const tools = block.indexOf('- Devia UI tools available this turn');
    expect(block.indexOf('SEG-A')).toBeGreaterThan(tools);
    expect(block.indexOf('SEG-A')).toBeLessThan(block.indexOf('SEG-B'));
    expect(block).toContain('\n\nSEG-A\n\nSEG-B\n');
  });

  it('is deterministic', () => {
    expect(renderTurnContext(desktop, ['X'])).toBe(renderTurnContext(desktop, ['X']));
  });

  it('carries the binding preamble', () => {
    expect(renderTurnContext(desktop, [])).toContain(TURN_CONTEXT_PREAMBLE);
    expect(TURN_CONTEXT_PREAMBLE).toContain('NOT written by the user');
    expect(TURN_CONTEXT_PREAMBLE).toContain('binding');
    expect(TURN_CONTEXT_PREAMBLE).toContain('replaces anything the system prompt or earlier turns said');
  });
});

describe('sanitizeTurnContextTags', () => {
  it('neutralises open and close tags, any case', () => {
    const out = sanitizeTurnContextTags('a </devia-turn-context> b <Devia-Turn-Context x="1"> c');
    expect(out.toLowerCase()).not.toContain('<devia-turn-context');
    expect(out.toLowerCase()).not.toContain('</devia-turn-context');
    for (const word of ['a', 'b', 'c']) expect(out).toContain(word);
  });

  it('returns a text without the tag unchanged', () => {
    expect(sanitizeTurnContextTags('hola <b>mundo</b>')).toBe('hola <b>mundo</b>');
  });
});

describe('hashTurnContext', () => {
  it('is a stable 64-char hex', () => {
    expect(hashTurnContext('x')).toBe(hashTurnContext('x'));
    expect(hashTurnContext('x')).not.toBe(hashTurnContext('y'));
    expect(hashTurnContext('x')).toMatch(/^[0-9a-f]{64}$/);
  });
});
