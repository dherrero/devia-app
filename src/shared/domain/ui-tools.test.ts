import { describe, expect, it } from 'vitest';

import {
  UI_LIMITS,
  UI_TOOL_KIND,
  PLAN_STEP_LIMITS,
  UI_TOOL_NAMES,
  buildPlanFollowUpPrompt,
  classifyUiDecision,
  isBlockingUiTool,
  isPlanRunDecision,
  normalizeConfirmInput,
  normalizeNotifyInput,
  normalizePickInput,
  normalizePlanApproveInput,
  normalizeRequestReviewInput,
  normalizeSendFileInput,
  normalizeSkillInput,
  normalizeTodoInput,
  normalizeUiToolInput,
  renderConfirmResult,
  renderPickResult,
  renderPlanApproveResult,
  renderRequestReviewResult,
  uiToolFromPublicName,
  uiToolPublicName,
} from './ui-tools';

const GARBAGE: unknown[] = [null, undefined, 0, '', '   ', [], {}, [1, 2], { nope: true }, NaN];

describe('ui tool identity', () => {
  it('exposes every name in the kind table', () => {
    for (const name of UI_TOOL_NAMES) expect(UI_TOOL_KIND[name]).toBeDefined();
    expect(Object.keys(UI_TOOL_KIND)).toHaveLength(UI_TOOL_NAMES.length);
  });

  it('round-trips public names', () => {
    for (const name of UI_TOOL_NAMES) {
      expect(uiToolFromPublicName(uiToolPublicName(name))).toBe(name);
    }
    expect(uiToolPublicName('ask_user')).toBe('devia_ask_user');
    expect(uiToolFromPublicName('devia_nope')).toBeNull();
    expect(uiToolFromPublicName('todo')).toBe('todo');
  });

  it('marks only the interactive tools as blocking', () => {
    expect(isBlockingUiTool('ask_user')).toBe(true);
    expect(isBlockingUiTool('plan_approve')).toBe(true);
    expect(isBlockingUiTool('todo')).toBe(false);
    expect(isBlockingUiTool('notify')).toBe(false);
    expect(isBlockingUiTool('send_file')).toBe(false);
  });
});

describe('normalizers never throw on garbage', () => {
  it.each([
    ['todo', normalizeTodoInput],
    ['plan_approve', normalizePlanApproveInput],
    ['request_review', normalizeRequestReviewInput],
    ['confirm', normalizeConfirmInput],
    ['pick', normalizePickInput],
    ['notify', normalizeNotifyInput],
    ['skill', normalizeSkillInput],
    ['send_file', normalizeSendFileInput],
  ] as const)('%s', (_name, normalize) => {
    for (const input of GARBAGE) expect(() => normalize(input)).not.toThrow();
  });
});

describe('normalizeTodoInput', () => {
  it('accepts plain strings and objects', () => {
    const result = normalizeTodoInput({ items: ['uno', { text: 'dos', status: 'done' }] });
    expect(result?.items).toEqual([
      { id: 't1', text: 'uno', status: 'pending' },
      { id: 't2', text: 'dos', status: 'done' },
    ]);
  });

  it('keeps at most one item in progress and degrades the rest', () => {
    const result = normalizeTodoInput({
      items: [
        { text: 'a', status: 'in_progress' },
        { text: 'b', status: 'in_progress' },
        { text: 'c', status: 'running' },
      ],
    });
    expect(result?.items.map((i) => i.status)).toEqual(['in_progress', 'pending', 'pending']);
  });

  it('clamps the item count and the text length', () => {
    const items = Array.from({ length: 80 }, (_, i) => `item ${i}`);
    const result = normalizeTodoInput({ items: [...items, 'x'.repeat(9_000)] });
    expect(result?.items).toHaveLength(UI_LIMITS.todoItems);
  });

  it('returns null when nothing usable is left', () => {
    expect(normalizeTodoInput({ items: [] })).toBeNull();
    expect(normalizeTodoInput({ items: [{ status: 'done' }] })).toBeNull();
  });
});

describe('normalizePlanApproveInput', () => {
  it('defaults the title and keeps optional fields omitted', () => {
    const result = normalizePlanApproveInput({ plan: '1. hacer algo' });
    expect(result?.plan).toBe('1. hacer algo');
    expect(result?.title).toBe('Plan propuesto');
    expect('risks' in (result ?? {})).toBe(false);
    expect('filesTouched' in (result ?? {})).toBe(false);
  });

  it('reads the alternative field names a model may use', () => {
    const result = normalizePlanApproveInput({
      header: 'Refactor',
      markdown: '- paso',
      files: ['a.ts', 3, 'b.ts'],
    });
    expect(result?.title).toBe('Refactor');
    expect(result?.filesTouched).toEqual(['a.ts', 'b.ts']);
  });

  it('rejects a payload with no plan body', () => {
    expect(normalizePlanApproveInput({ title: 'solo titulo' })).toBeNull();
  });

  // S-28 T-336
  it('reads steps as strings or objects and numbers them in order', () => {
    const result = normalizePlanApproveInput({
      plan: 'x',
      steps: ['uno', { text: 'dos' }, '   ', { nope: 1 }, 7, { id: 'mine', title: 'tres' }],
    });
    expect(result?.steps).toEqual([
      { id: 'step-1', text: 'uno' },
      { id: 'step-2', text: 'dos' },
      { id: 'step-3', text: 'tres' },
    ]);
  });

  it('clamps the step count and length, and omits steps when none survive', () => {
    const many = Array.from({ length: 40 }, (_, i) => `paso ${i}`);
    const result = normalizePlanApproveInput({ plan: 'x', steps: [...many, 'y'.repeat(900)] });
    expect(result?.steps).toHaveLength(PLAN_STEP_LIMITS.count);
    const long = normalizePlanApproveInput({ plan: 'x', steps: ['y'.repeat(900)] });
    expect(long?.steps?.[0]?.text.length).toBeLessThanOrEqual(PLAN_STEP_LIMITS.text);
    expect('steps' in (normalizePlanApproveInput({ plan: 'x', steps: [] }) ?? {})).toBe(false);
  });
});

describe('buildPlanFollowUpPrompt', () => {
  it('ties the run to devia_todo with the plan step ids', () => {
    const prompt = buildPlanFollowUpPrompt({
      title: 'T',
      plan: 'cuerpo',
      steps: [
        { id: 'step-1', text: 'uno' },
        { id: 'step-2', text: 'dos' },
      ],
    });
    expect(prompt).toContain('devia_todo');
    expect(prompt).toContain('- step-1: uno');
    expect(prompt).toContain('- step-2: dos');
  });

  it('says nothing about devia_todo when the plan has no steps', () => {
    expect(buildPlanFollowUpPrompt({ title: 'T', plan: 'cuerpo' })).not.toContain('devia_todo');
  });
});

describe('normalizeConfirmInput', () => {
  it('accepts a bare string', () => {
    expect(normalizeConfirmInput('rm -rf dist')).toEqual({ action: 'rm -rf dist' });
  });

  it('carries the danger flag only when explicitly true', () => {
    expect(normalizeConfirmInput({ action: 'x', danger: true })?.danger).toBe(true);
    expect('danger' in (normalizeConfirmInput({ action: 'x', danger: 'yes' }) ?? {})).toBe(false);
  });
});

describe('normalizePickInput / normalizeNotifyInput / normalizeSkillInput', () => {
  it('maps filter aliases', () => {
    expect(normalizePickInput({ filter: 'folder' }).filter).toBe('dir');
    expect(normalizePickInput({ type: 'file' }).filter).toBe('file');
    expect('filter' in normalizePickInput({ filter: 'weird' })).toBe(false);
  });

  it('maps notify level aliases and requires a title', () => {
    expect(normalizeNotifyInput({ title: 'a', severity: 'warning' })?.level).toBe('warn');
    expect(normalizeNotifyInput({ body: 'sin titulo' })).toBeNull();
    expect(normalizeNotifyInput('listo')).toEqual({ title: 'listo' });
  });

  it('defaults skill to list and requires a name to load', () => {
    expect(normalizeSkillInput({})).toEqual({ op: 'list' });
    expect(normalizeSkillInput({ op: 'load' })).toBeNull();
    expect(normalizeSkillInput({ op: 'read', name: 'electron' })).toEqual({
      op: 'load',
      name: 'electron',
    });
    expect(normalizeSkillInput({ op: 'delete', name: 'x' })).toBeNull();
  });
});

describe('normalizeSendFileInput', () => {
  it('reads the canonical shape', () => {
    expect(normalizeSendFileInput({ path: 'out/report.pdf', caption: 'Hecho', as: 'document' })).toEqual({
      path: 'out/report.pdf',
      caption: 'Hecho',
      as: 'document',
    });
  });

  it('accepts the aliases an agent tends to send', () => {
    expect(normalizeSendFileInput({ file: 'a.png', message: 'hi' })).toEqual({
      path: 'a.png',
      caption: 'hi',
      as: 'auto',
    });
    expect(normalizeSendFileInput({ filePath: 'b.txt', text: 'x' })).toMatchObject({
      path: 'b.txt',
      caption: 'x',
    });
  });

  it('treats a bare string as the path', () => {
    expect(normalizeSendFileInput('  shot.png ')).toEqual({ path: 'shot.png', as: 'auto' });
  });

  it('degrades an unknown `as` to auto', () => {
    expect(normalizeSendFileInput({ path: 'a', as: 'sticker' })?.as).toBe('auto');
    expect(normalizeSendFileInput({ path: 'a', as: 'photo' })?.as).toBe('photo');
  });

  it('clamps the caption to the Telegram limit', () => {
    const out = normalizeSendFileInput({ path: 'a', caption: 'x'.repeat(5_000) });
    expect(out?.caption).toHaveLength(UI_LIMITS.sendFileCaption);
    expect(UI_LIMITS.sendFileCaption).toBe(1_024);
  });

  it('returns null without a usable path', () => {
    expect(normalizeSendFileInput({ caption: 'no file' })).toBeNull();
    expect(normalizeSendFileInput({ path: '   ' })).toBeNull();
    expect(normalizeSendFileInput({ path: 42 })).toBeNull();
    expect(normalizeSendFileInput('')).toBeNull();
  });

  it('rejects rather than truncates a path it cannot carry intact', () => {
    expect(normalizeSendFileInput({ path: 'a'.repeat(UI_LIMITS.path + 1) })).toBeNull();
    expect(normalizeSendFileInput({ path: 'a\0b' })).toBeNull();
  });

  it('keeps the fields the MCP server already resolved', () => {
    expect(
      normalizeSendFileInput({
        path: 'out/a.png',
        as: 'auto',
        absPath: '/ws/p/out/a.png',
        name: 'a.png',
        size: 1234,
        mime: 'image/png',
      }),
    ).toEqual({
      path: 'out/a.png',
      as: 'auto',
      absPath: '/ws/p/out/a.png',
      name: 'a.png',
      size: 1234,
      mime: 'image/png',
    });
  });

  it('drops an enriched size that is not a byte count', () => {
    expect(normalizeSendFileInput({ path: 'a', size: -1 })).not.toHaveProperty('size');
    expect(normalizeSendFileInput({ path: 'a', size: 1.5 })).not.toHaveProperty('size');
    expect(normalizeSendFileInput({ path: 'a', size: '9' })).not.toHaveProperty('size');
  });

  it('is reachable through the dispatcher', () => {
    expect(normalizeUiToolInput('send_file', { path: 'a.txt' })).toEqual({ path: 'a.txt', as: 'auto' });
  });

  it('caps the files a run may send', () => {
    expect(UI_LIMITS.sendFilesPerRun).toBe(10);
  });
});

describe('normalizeRequestReviewInput', () => {
  it('omits absent fields instead of setting undefined', () => {
    expect(normalizeRequestReviewInput(undefined)).toEqual({});
    expect(normalizeRequestReviewInput({ files: ['a.ts'] })).toEqual({ paths: ['a.ts'] });
  });
});

describe('result renderers', () => {
  it('tells the agent to end its turn on approve_and_run', () => {
    const text = renderPlanApproveResult({ decision: 'approve_and_run' });
    expect(text).toContain('End your turn');
    expect(text).toContain('apply mode');
  });

  it('tells the agent to keep working on reject', () => {
    const text = renderPlanApproveResult({ decision: 'reject', comment: 'usa signals' });
    expect(text).toContain('REJECTED');
    expect(text).toContain('usa signals');
  });

  it('tells the agent to refine the plan on the board on keep_planning', () => {
    const text = renderPlanApproveResult({ decision: 'keep_planning', comment: 'falta Telegram' });
    expect(text).toContain('KEEP PLANNING');
    expect(text).toContain('falta Telegram');
    expect(text).toContain('duplicate spec');
    expect(text).not.toContain('End your turn');
  });

  it('marks yolo approvals so the audit log can tell them apart from apply', () => {
    const yolo = renderPlanApproveResult({ decision: 'approve_and_run_yolo' });
    expect(yolo).toContain('End your turn');
    expect(classifyUiDecision('plan_approve', yolo)).toBe('approved_and_run_yolo');
    expect(classifyUiDecision('plan_approve', renderPlanApproveResult({ decision: 'approve_and_run' }))).toBe(
      'approved_and_run',
    );
    expect(classifyUiDecision('plan_approve', renderPlanApproveResult({ decision: 'keep_planning' }))).toBe(
      'keep_planning',
    );
  });

  it('builds the follow-up prompt per mode', () => {
    const plan = { title: 'T', plan: 'cuerpo' };
    expect(buildPlanFollowUpPrompt(plan)).toContain('switched to apply mode.');
    expect(buildPlanFollowUpPrompt(plan, true)).toContain('without permission prompts');
  });

  it('only run decisions start an execution', () => {
    expect(isPlanRunDecision('approve_and_run')).toBe(true);
    expect(isPlanRunDecision('approve_and_run_yolo')).toBe(true);
    expect(isPlanRunDecision('keep_planning')).toBe(false);
    expect(isPlanRunDecision('approve')).toBe(false);
  });

  it('never renders a refusal as success', () => {
    expect(renderConfirmResult({ decision: 'no' })).toContain('Do NOT');
    expect(renderConfirmResult({ decision: 'always' })).toContain('do not ask again');
  });

  it('renders an empty pick as a neutral instruction', () => {
    expect(renderPickResult({ paths: [] })).toContain('did not select');
    expect(renderPickResult({ paths: ['a.ts'] })).toContain('- a.ts');
  });

  it('renders a cancelled review as neutral, not an error', () => {
    expect(renderRequestReviewResult({ decision: 'cancel' })).toContain('without leaving comments');
    expect(renderRequestReviewResult({ decision: 'empty' })).toContain('no uncommitted changes');
    expect(renderRequestReviewResult({ decision: 'send', prompt: 'revisa: x' })).toContain(
      'revisa: x',
    );
  });
});
