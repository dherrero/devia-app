import type { KanbanCardView, KanbanSpec } from '../../../../types/devia';

export type KanbanPriority = 'high' | 'medium' | 'low' | 'none';
export type KanbanPriorityFilter = KanbanPriority | 'all';

export type KanbanCardWithPriority = KanbanCardView & {
  readonly priority?: KanbanPriority;
};

const PRIORITIES: ReadonlySet<string> = new Set(['high', 'medium', 'low', 'none']);

export function cardPriority(card: KanbanCardView): KanbanPriority {
  const value = (card as KanbanCardWithPriority).priority;
  return value && PRIORITIES.has(value) ? value : 'none';
}

export function priorityLabel(priority: KanbanPriority): string {
  switch (priority) {
    case 'high': return 'Alta';
    case 'medium': return 'Media';
    case 'low': return 'Baja';
    default: return '';
  }
}

export function filterKanbanCards(
  cards: ReadonlyArray<KanbanCardView>,
  specs: ReadonlyArray<KanbanSpec>,
  search: string,
  priority: KanbanPriorityFilter,
): KanbanCardView[] {
  const query = search.trim().toLowerCase();
  const specTitles = new Map(specs.map((spec) => [spec.id, spec.title.toLowerCase()]));

  return cards.filter((card) => {
    const matchesSearch =
      !query ||
      card.id.toLowerCase().includes(query) ||
      card.title.toLowerCase().includes(query) ||
      card.specId.toLowerCase().includes(query) ||
      (specTitles.get(card.specId) ?? '').includes(query);
    const matchesPriority = priority === 'all' || cardPriority(card) === priority;
    return matchesSearch && matchesPriority;
  });
}
