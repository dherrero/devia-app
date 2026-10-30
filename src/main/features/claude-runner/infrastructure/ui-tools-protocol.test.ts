import { describe, expect, it } from 'vitest';

import { UI_TOOL_NAMES, type UiToolName } from '../../../../shared/domain/ui-tools';
import { buildUiFallbackHint, buildUiToolsHint } from './ui-tools-protocol';

describe('buildUiToolsHint', () => {
  it('announces nothing when the run got nothing', () => {
    expect(buildUiToolsHint([])).toBeNull();
  });

  it('announces exactly the tools the run got, and no others', () => {
    const hint = buildUiToolsHint(['ask_user', 'todo']) as string;
    expect(hint).toContain('devia_ask_user');
    expect(hint).toContain('devia_todo');
    expect(hint).not.toContain('devia_confirm');
    expect(hint).not.toContain('devia_plan_approve');
  });

  it('covers every tool name, so a new one cannot ship unannounced', () => {
    for (const name of UI_TOOL_NAMES) {
      expect(buildUiToolsHint([name])).toContain(`devia_${name}`);
    }
  });

  it('never mentions the retired Claude built-in', () => {
    expect(buildUiToolsHint([...UI_TOOL_NAMES])).not.toContain('AskUserQuestion');
  });
});

describe('buildUiFallbackHint', () => {
  const ALL_DECISION_TOOLS: UiToolName[] = [
    'ask_user',
    'plan_approve',
    'request_review',
    'confirm',
  ];

  it('says nothing when every decision-carrying tool is present', () => {
    expect(buildUiFallbackHint(ALL_DECISION_TOOLS)).toBeNull();
    expect(buildUiFallbackHint([...UI_TOOL_NAMES])).toBeNull();
  });

  it('covers every missing capability and only those', () => {
    const hint = buildUiFallbackHint(['ask_user']) as string;
    expect(hint).not.toContain('multiple-choice tool');
    expect(hint).toContain('plan-approval card');
    expect(hint).toContain('diff-review card');
    expect(hint).toContain('confirmation card');
  });

  it('does not lecture about the convenience tools', () => {
    const hint = buildUiFallbackHint(ALL_DECISION_TOOLS.slice(0, 1)) as string;
    expect(hint).not.toContain('devia_todo');
    expect(hint).not.toContain('devia_notify');
    expect(hint).not.toContain('devia_pick');
    expect(hint).not.toContain('devia_skill');
  });

  it('always closes with the multi-turn rule, so the agent knows to end its turn', () => {
    const hint = buildUiFallbackHint([]) as string;
    expect(hint).toContain('end your turn');
    expect(hint).toContain('persistent');
  });

  it('is the exact complement of the announcement', () => {
    // Announcing a tool and telling the agent it is missing at the same time is
    // the one failure mode this pair exists to prevent.
    for (const name of ALL_DECISION_TOOLS) {
      const announced = buildUiToolsHint([name]) as string;
      const fallback = buildUiFallbackHint([name]) ?? '';
      expect(announced).toContain(`devia_${name}`);
      expect(fallback).not.toContain(`devia_${name}`);
    }
  });
});

describe('send_file (S-32 T-368)', () => {
  const REMOTE_APPLY: UiToolName[] = ['todo', 'notify', 'skill'];

  it('announces the tool, never the outbox', () => {
    const hint = buildUiToolsHint(['send_file']) as string;
    expect(hint).toContain('devia_send_file');
    expect(hint).toContain('50 MB');
    expect(hint).not.toContain('outbox');
    expect(buildUiFallbackHint([...REMOTE_APPLY, 'send_file'], { canSendFiles: true, mode: 'apply' }) ?? '')
      .not.toContain('outbox');
  });

  it('points at the outbox when the run can send files but did not get the tool', () => {
    const hint = buildUiFallbackHint(REMOTE_APPLY, { canSendFiles: true, mode: 'apply' }) as string;
    expect(hint).toContain('`outbox/`');
    expect(hint).not.toContain('devia_send_file');
    // Still inside the regular fallback, before the multi-turn footer.
    expect(hint.indexOf('outbox/')).toBeLessThan(hint.indexOf('persistent'));
  });

  it('stands alone when the file channel is the only thing missing', () => {
    const all: UiToolName[] = ['ask_user', 'plan_approve', 'request_review', 'confirm'];
    const hint = buildUiFallbackHint(all, { canSendFiles: true, mode: 'apply' }) as string;
    expect(hint).toContain('`outbox/`');
    expect(hint).not.toContain('no interactive UI');
    expect(hint).not.toContain('persistent');
  });

  it('does not promise the outbox in plan mode, where nothing can be copied', () => {
    const hint = buildUiFallbackHint(['ask_user', 'plan_approve'], { canSendFiles: true, mode: 'plan' }) as string;
    expect(hint).not.toContain('outbox');
    expect(hint).toContain('cannot send files');
  });

  it('says nothing about files without a relay — byte-identical to the pre-S-32 output', () => {
    for (const set of [[], REMOTE_APPLY, ['ask_user', 'plan_approve', 'request_review', 'confirm']] as UiToolName[][]) {
      for (const mode of ['plan', 'apply', 'apply-yolo'] as const) {
        expect(buildUiFallbackHint(set, { canSendFiles: false, mode })).toBe(buildUiFallbackHint(set));
      }
    }
    expect(buildUiFallbackHint(['ask_user', 'plan_approve', 'request_review', 'confirm'], { mode: 'apply' })).toBeNull();
  });
});
