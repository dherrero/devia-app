export type KanbanLabelId =
  | 'bug'
  | 'feature'
  | 'chore'
  | 'test'
  | 'docs'
  | 'ux';

export const KANBAN_LABELS: Record<
  KanbanLabelId,
  { text: string; bg: string; fg: string }
> = {
  bug: { text: 'Bug', bg: 'oklch(60% 0.20 25)', fg: '#fff' },
  feature: { text: 'Feature', bg: 'oklch(55% 0.24 280)', fg: '#fff' },
  chore: { text: 'Chore', bg: 'oklch(48% 0.08 270)', fg: '#fff' },
  test: { text: 'Test', bg: 'oklch(50% 0.18 145)', fg: '#fff' },
  docs: { text: 'Docs', bg: 'oklch(55% 0.18 300)', fg: '#fff' },
  ux: { text: 'UX', bg: 'oklch(62% 0.16 55)', fg: '#fff' },
};

export interface KanbanAssignee {
  id: string;
  name: string;
  avatarUrl?: string;
  initials?: string;
}

export interface KanbanItem {
  id: string;
  title: string;
  description?: string | null;
  priority?: 'alta' | 'media' | 'none';
  dueDate?: string | null;
  version?: string | null;
  assignee?: KanbanAssignee | null;
  disabled?: boolean;
  draggable?: boolean;
  labels?: KanbanLabelId[];
  commentsCount?: number;
}

export interface KanbanColumn {
  id: string;
  title: string;
  items: KanbanItem[];
  disabled?: boolean;
  /** WIP limit — null means no limit */
  wip?: number | null;
  /** Cards in this column render with strikethrough */
  isDone?: boolean;
  /** Column renders as narrow vertical strip */
  collapsed?: boolean;
}

export interface KanbanMoveEvent {
  item: KanbanItem;
  previousColumnId: string;
  currentColumnId: string;
  previousIndex: number;
  currentIndex: number;
}

export interface KanbanInlineCardEvent {
  columnId: string;
  title: string;
}

export interface KanbanColMenuEvent {
  colId: string;
  anchorRect: { bottom: number; right: number };
}

export interface KanbanColumnMoveEvent {
  previousIndex: number;
  currentIndex: number;
  /** Column IDs in the new order after the move. */
  columnIds: string[];
}
