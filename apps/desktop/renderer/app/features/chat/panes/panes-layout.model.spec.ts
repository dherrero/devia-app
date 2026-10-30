/**
 * S-13 T-143 — split-view layout model + split-icon state machine.
 */
import { describe, it, expect } from 'vitest';
import type { SessionRef } from '../../../../../shared/domain/session-ref';
import {
  type Pane,
  type PanesLayout,
  singlePaneLayout,
  splitVertical,
  splitHorizontal,
  closePane,
  focusPane,
  splitIconFor,
  paneCount,
  isFull,
} from './panes-layout.model';

function pane(id: string): Pane {
  const ref: SessionRef = { baseProject: '/ws/proj', sessionId: id, workdir: `/wt/${id}` };
  return { id, sessionRef: ref };
}

const A = pane('a');
const B = pane('b');
const C = pane('c');
const D = pane('d');
const base: PanesLayout = singlePaneLayout(A);

describe('panes-layout — construction + queries', () => {
  it('single-pane layout has one column, one pane, focused on it', () => {
    expect(paneCount(base)).toBe(1);
    expect(base.columns).toHaveLength(1);
    expect(base.focusedPaneId).toBe('a');
  });
});

describe('panes-layout — split state machine (icons)', () => {
  it('1 column → vertical', () => {
    expect(splitIconFor(base, 0)).toBe('vertical');
  });

  it('2 columns, each 1 row → horizontal on both', () => {
    const l = splitVertical(base, B);
    expect(splitIconFor(l, 0)).toBe('horizontal');
    expect(splitIconFor(l, 1)).toBe('horizontal');
  });

  it('a column with 2 rows → none for that column', () => {
    const l = splitHorizontal(splitVertical(base, B), 0, C);
    expect(splitIconFor(l, 0)).toBe('none'); // 2 rows
    expect(splitIconFor(l, 1)).toBe('horizontal'); // still 1 row
  });

  it('at 4 panes → none everywhere', () => {
    let l = splitVertical(base, B);
    l = splitHorizontal(l, 0, C);
    l = splitHorizontal(l, 1, D);
    expect(paneCount(l)).toBe(4);
    expect(isFull(l)).toBe(true);
    expect(splitIconFor(l, 0)).toBe('none');
    expect(splitIconFor(l, 1)).toBe('none');
  });
});

describe('panes-layout — transitions', () => {
  it('splitVertical opens a 2nd column and focuses the new pane', () => {
    const l = splitVertical(base, B);
    expect(l.columns).toHaveLength(2);
    expect(l.focusedPaneId).toBe('b');
  });

  it('splitVertical is a no-op at 2 columns', () => {
    const l = splitVertical(base, B);
    expect(splitVertical(l, C)).toBe(l);
  });

  it('splitHorizontal adds a row below and focuses the new pane', () => {
    const l = splitHorizontal(splitVertical(base, B), 0, C);
    expect(l.columns[0].panes.map((p) => p.id)).toEqual(['a', 'c']);
    expect(l.focusedPaneId).toBe('c');
  });

  it('splitHorizontal is a no-op on a column that already has 2 rows', () => {
    const l = splitHorizontal(splitVertical(base, B), 0, C);
    expect(splitHorizontal(l, 0, D)).toBe(l);
  });

  it('no split exceeds 4 panes', () => {
    let l = splitVertical(base, B);
    l = splitHorizontal(l, 0, C);
    l = splitHorizontal(l, 1, D);
    expect(splitVertical(l, pane('e'))).toBe(l);
    expect(splitHorizontal(l, 0, pane('e'))).toBe(l);
  });
});

describe('panes-layout — close + recompose', () => {
  it('closing a pane in a 2-column layout collapses back to 1 column', () => {
    const two = splitVertical(base, B);
    const back = closePane(two, 'b');
    expect(back.columns).toHaveLength(1);
    expect(splitIconFor(back, 0)).toBe('vertical'); // icon reverts
  });

  it('closing the focused pane moves focus to the first remaining pane', () => {
    const two = splitVertical(base, B); // focus on b
    const back = closePane(two, 'b');
    expect(back.focusedPaneId).toBe('a');
  });

  it('closing a non-focused pane keeps focus', () => {
    let l = splitVertical(base, B); // focus b
    l = focusPane(l, 'a'); // focus a
    l = closePane(l, 'b');
    expect(l.focusedPaneId).toBe('a');
  });

  it('closing the last pane is a no-op (primary anchor stays)', () => {
    expect(closePane(base, 'a')).toBe(base);
  });

  it('closing an unknown pane id returns the same layout', () => {
    expect(closePane(base, 'zzz')).toBe(base);
  });

  it('a 2×2 grid closing one row drops to 3 panes and frees that column icon', () => {
    let l = splitVertical(base, B);
    l = splitHorizontal(l, 0, C);
    l = splitHorizontal(l, 1, D); // 2x2, 4 panes
    l = closePane(l, 'c'); // remove bottom of col 0
    expect(paneCount(l)).toBe(3);
    expect(splitIconFor(l, 0)).toBe('horizontal'); // col0 back to 1 row
  });
});

describe('panes-layout — focus', () => {
  it('focusPane moves focus; unknown id is a no-op', () => {
    const two = splitVertical(base, B);
    expect(focusPane(two, 'a').focusedPaneId).toBe('a');
    expect(focusPane(two, 'nope')).toBe(two);
  });
});
