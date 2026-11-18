import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { ButtonComponent, IconComponent, SpinnerComponent } from '@devia/ui';
import { LucideCopy, LucideExternalLink } from '@lucide/angular';

import type {
  GraphDirDetail, GraphFileDetail, GraphNode, GraphNodeDetail, GraphSymbolDetail,
} from '../../../../../../shared/domain/code-graph';
import { AppStateService } from '../../../../core/services/app-state.service';
import { ElectronApiService } from '../../../../core/services/electron-api.service';
import { GraphViewStore } from '../../services/graph-view.store';
import { kindIcon } from '../../utils/kind-icon';
import { pluralKey } from '../../utils/plural';
import { graphAbsolutePath } from '../../utils/project-path';

type DetailState =
  | { status: 'idle' }
  | { status: 'more' }
  | { status: 'loading'; id: string }
  | { status: 'missing'; id: string }
  | { status: 'error'; id: string }
  | { status: 'ready'; id: string; detail: GraphNodeDetail };

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/**
 * Detail of the selected graph node (S-44 T-511): what it is and where, and
 * the nodes around it — callers, callees and the files a change would affect
 * for a symbol; imports for a file; counts and central nodes for a directory.
 * Every listed node reveals itself in the graph. Copy path / Open in IDE use
 * the file's absolute path (the IDE through the shell feature's existing
 * `openInIde`). A newer selection or a graph change on disk supersedes a
 * pending request.
 */
@Component({
  selector: 'ds-cg-node-detail',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, IconComponent, NgTemplateOutlet, SpinnerComponent, TranslateModule],
  templateUrl: './node-detail.component.html',
  styleUrl: './node-detail.component.scss',
})
export class NodeDetailComponent {
  readonly store = inject(GraphViewStore);
  private readonly api = inject(ElectronApiService);
  private readonly appState = inject(AppStateService);
  private readonly translate = inject(TranslateService);

  readonly LucideCopy = LucideCopy;
  readonly LucideExternalLink = LucideExternalLink;
  readonly kindIcon = kindIcon;
  readonly searchKeys = IS_MAC ? '⌘F' : 'Ctrl+F';

  readonly state = signal<DetailState>({ status: 'idle' });
  readonly announcement = signal('');
  private seq = 0;

  readonly symbol = computed<GraphSymbolDetail | null>(() => {
    const s = this.state();
    return s.status === 'ready' && s.detail.kind === 'symbol' ? s.detail : null;
  });
  readonly file = computed<GraphFileDetail | null>(() => {
    const s = this.state();
    return s.status === 'ready' && s.detail.kind === 'file' ? s.detail : null;
  });
  readonly dir = computed<GraphDirDetail | null>(() => {
    const s = this.state();
    return s.status === 'ready' && s.detail.kind === 'dir' ? s.detail : null;
  });
  /** Root-relative path of what is shown, for Copy path / Open in IDE. */
  readonly path = computed<string | null>(() => {
    const s = this.state();
    if (s.status !== 'ready') return null;
    return s.detail.kind === 'dir' ? s.detail.path : s.detail.kind === 'file' ? s.detail.path : s.detail.node.filePath;
  });

  constructor() {
    effect(() => {
      const id = this.store.selectedId();
      const project = this.store.projectKey();
      this.store.shownRevision();
      untracked(() => void this.load(project, id));
    });
  }

  plural(key: string, count: number): string {
    return pluralKey(key, count);
  }

  basename(path: string): string {
    return path.slice(path.lastIndexOf('/') + 1) || path;
  }

  location(node: GraphNode): string {
    return `${node.filePath}:${node.startLine}`;
  }

  reveal(id: string): void {
    void this.store.revealNode(id);
  }

  async copyPath(): Promise<void> {
    const absolute = this.absolute();
    if (absolute === null) return;
    try {
      await navigator.clipboard.writeText(absolute);
      this.announce('codeGraph.detail.copied');
    } catch {
      this.announce('codeGraph.detail.copy_failed');
    }
  }

  async openInIde(): Promise<void> {
    const absolute = this.absolute();
    if (absolute === null) return;
    try {
      await this.api.openInIde(absolute);
    } catch {
      this.announce('codeGraph.detail.open_failed');
    }
  }

  private absolute(): string | null {
    const project = this.store.projectKey();
    const path = this.path();
    if (project === null || path === null) return null;
    return graphAbsolutePath(this.appState.config()?.workspaceRoot, project, path);
  }

  private announce(key: string): void {
    const text = this.translate.instant(key) as string;
    this.announcement.set(text === this.announcement() ? `${text}\u00A0` : text);
  }

  private async load(project: string | null, id: string | null): Promise<void> {
    const seq = ++this.seq;
    if (project === null || id === null) {
      this.state.set({ status: 'idle' });
      return;
    }
    if (id.startsWith('more:')) {
      this.state.set({ status: 'more' });
      return;
    }
    const current = this.state();
    // A refresh of the node already shown keeps it on screen instead of flashing a spinner.
    if (!(current.status === 'ready' && current.id === id)) this.state.set({ status: 'loading', id });
    try {
      const detail = await this.api.codeGraphNodeDetail(project, id);
      if (seq !== this.seq) return;
      this.state.set(detail ? { status: 'ready', id, detail } : { status: 'missing', id });
    } catch {
      if (seq !== this.seq) return;
      this.state.set({ status: 'error', id });
    }
  }
}
