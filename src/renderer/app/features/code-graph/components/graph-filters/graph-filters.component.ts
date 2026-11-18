import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import { ButtonComponent } from '@devia/ui';

import { EDGE_KINDS, NODE_KINDS } from '../../../../../../shared/domain/code-graph';
import {
  DEFAULT_FILTERS, GraphViewStore, isMoreNode, type GraphViewFilters, type ViewEdgeKind, type ViewNodeKind,
} from '../../services/graph-view.store';
import { pluralKey } from '../../utils/plural';

const NODE_ORDER: readonly ViewNodeKind[] = ['dir', ...NODE_KINDS];
const EDGE_ORDER: readonly ViewEdgeKind[] = [...EDGE_KINDS, 'aggregate'];

interface Chip<K extends string> {
  kind: K;
  label: string;
  on: boolean;
}

/**
 * Filters of the graph view (S-44 T-511): a chip per node kind and relation
 * kind on screen (a hidden kind keeps its chip so it can come back) plus the
 * tests / generated switches. They only hide: `GraphViewStore.setFilters`
 * never reloads nor drops anything.
 */
@Component({
  selector: 'ds-cg-filters',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, TranslateModule],
  templateUrl: './graph-filters.component.html',
  styleUrl: './graph-filters.component.scss',
})
export class GraphFiltersComponent {
  readonly store = inject(GraphViewStore);

  readonly filters = this.store.filters;

  readonly nodeChips = computed<Chip<ViewNodeKind>[]>(() => {
    const shown = this.filters().nodeKinds;
    const present = new Set<ViewNodeKind>();
    for (const node of this.store.nodes()) if (!isMoreNode(node)) present.add(node.kind);
    return NODE_ORDER
      .filter((kind) => present.has(kind) || (shown !== undefined && !shown.includes(kind)))
      .map((kind) => ({ kind, label: `codeGraph.canvas.kind.${kind}`, on: shown === undefined || shown.includes(kind) }));
  });

  readonly edgeChips = computed<Chip<ViewEdgeKind>[]>(() => {
    const shown = this.filters().edgeKinds;
    const present = new Set(this.store.edges().map((edge) => edge.kind));
    return EDGE_ORDER
      .filter((kind) => present.has(kind) || (shown !== undefined && !shown.includes(kind)))
      .map((kind) => ({ kind, label: `codeGraph.filters.edge.${kind}`, on: shown === undefined || shown.includes(kind) }));
  });

  readonly hidden = this.store.hiddenCount;
  readonly hiddenKey = computed(() => pluralKey('codeGraph.filters.hidden', this.hidden()));
  readonly filtering = computed(() => {
    const f = this.filters();
    return f.nodeKinds !== undefined || f.edgeKinds !== undefined || !f.showTests || !f.showGenerated;
  });

  toggleNode(kind: ViewNodeKind): void {
    this.update({ nodeKinds: toggle(this.filters().nodeKinds, kind, NODE_ORDER) });
  }

  toggleEdge(kind: ViewEdgeKind): void {
    this.update({ edgeKinds: toggle(this.filters().edgeKinds, kind, EDGE_ORDER) });
  }

  toggleTests(): void {
    this.update({ showTests: !this.filters().showTests });
  }

  toggleGenerated(): void {
    this.update({ showGenerated: !this.filters().showGenerated });
  }

  reset(): void {
    this.store.setFilters(DEFAULT_FILTERS);
  }

  private update(change: Partial<GraphViewFilters>): void {
    const next: GraphViewFilters = { ...this.filters(), ...change };
    if (next.nodeKinds === undefined) delete next.nodeKinds;
    if (next.edgeKinds === undefined) delete next.edgeKinds;
    this.store.setFilters(next);
  }
}

/** Flips `kind` in a "visible kinds" list; every kind visible again means no filter (undefined). */
function toggle<K extends string>(shown: readonly K[] | undefined, kind: K, all: readonly K[]): K[] | undefined {
  const current = new Set(shown ?? all);
  if (current.has(kind)) current.delete(kind);
  else current.add(kind);
  return all.every((k) => current.has(k)) ? undefined : all.filter((k) => current.has(k));
}
