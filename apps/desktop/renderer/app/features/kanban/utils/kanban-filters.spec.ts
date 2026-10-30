import { describe, expect, it } from 'vitest';
import { filterKanbanCards, type KanbanCardWithPriority } from './kanban-filters';
import type { KanbanSpec } from '../../../../types/devia';

const specs: KanbanSpec[] = [
  { id: 'S-1', title: 'Billing Portal', description: '', createdAt: 1 },
  { id: 'S-2', title: 'Audit Trail', description: '', createdAt: 1 },
];

const cards: KanbanCardWithPriority[] = [
  {
    id: 'T-1',
    specId: 'S-1',
    title: 'Add invoice filters',
    column: 'todo',
    dependsOn: [],
    sortIndex: 0,
    unreadCount: 0,
    subagentNames: [],
    hasCommit: false,
    priority: 'high',
  },
  {
    id: 'T-2',
    specId: 'S-2',
    title: 'Render audit detail',
    column: 'backlog',
    dependsOn: [],
    sortIndex: 1,
    unreadCount: 0,
    subagentNames: [],
    hasCommit: false,
    priority: 'low',
  },
];

describe('filterKanbanCards', () => {
  it('matches title, id, spec id and spec title', () => {
    expect(filterKanbanCards(cards, specs, 'invoice', 'all').map((c) => c.id)).toEqual(['T-1']);
    expect(filterKanbanCards(cards, specs, 'T-2', 'all').map((c) => c.id)).toEqual(['T-2']);
    expect(filterKanbanCards(cards, specs, 'S-1', 'all').map((c) => c.id)).toEqual(['T-1']);
    expect(filterKanbanCards(cards, specs, 'audit trail', 'all').map((c) => c.id)).toEqual(['T-2']);
  });

  it('combines search and priority without mutating the source array', () => {
    const before = [...cards];
    expect(filterKanbanCards(cards, specs, 'audit', 'high')).toEqual([]);
    expect(filterKanbanCards(cards, specs, 'audit', 'low').map((c) => c.id)).toEqual(['T-2']);
    expect(cards).toEqual(before);
  });
});
