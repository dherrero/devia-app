import {
  ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal,
} from '@angular/core';
import { IconComponent } from '@devia/ui';
import {
  LucideChevronDown, LucideChevronRight, LucideFolderOpen, LucideFolder, LucideFileText,
} from '@lucide/angular';
import { TranslateModule } from '@ngx-translate/core';
import type { ProjectTreeNode } from '../../../../../../../../shared/domain/project-tree';
import { ElectronApiService } from '../../../../../../core/services/electron-api.service';

/**
 * Recursive renderer for a single tree entry. Files emit `fileOpen` on
 * click; folders lazy-load their children the first time they expand and
 * cache them in a local signal. The parent component listens to a global
 * "refresh" event by re-mounting the root via a refreshToken input,
 * which tears down all cached children.
 */
@Component({
  selector: 'ds-tree-node',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent, TranslateModule],
  templateUrl: './tree-node.component.html',
  styleUrl: './tree-node.component.scss',
})
export class TreeNodeComponent {
  readonly LucideChevronDown = LucideChevronDown;
  readonly LucideChevronRight = LucideChevronRight;
  readonly LucideFolderOpen = LucideFolderOpen;
  readonly LucideFolder = LucideFolder;
  readonly LucideFileText = LucideFileText;

  readonly node = input.required<ProjectTreeNode>();
  readonly project = input.required<string>();
  readonly depth = input<number>(0);
  /** Bumping this input from the parent invalidates all cached children
   *  in every descendant — used when the user (or a git event) triggers
   *  a refresh of the whole tree. Implemented as a monotonic number. */
  readonly refreshToken = input<number>(0);

  readonly fileOpen = output<string>();

  private readonly api = inject(ElectronApiService);

  readonly expanded = signal(false);
  readonly children = signal<ProjectTreeNode[]>([]);
  readonly loading = signal(false);
  readonly error = signal(false);
  /** Token of the load that produced `children`. Mismatches refreshToken
   *  trigger a reload on the next expand. */
  private loadedAt = -1;

  readonly statusLetter = computed(() => {
    switch (this.node().status) {
      case 'modified': return 'M';
      case 'added': return 'A';
      case 'untracked': return 'U';
      case 'deleted': return 'D';
      case 'renamed': return 'R';
      default: return '';
    }
  });

  readonly rowTooltip = computed(() => {
    const n = this.node();
    return n.status ? `${n.path} (${n.status})` : n.path;
  });

  constructor() {
    // When the parent bumps refreshToken (project change, manual refresh,
    // git event), re-fetch any folder we're already showing expanded so
    // the user sees up-to-date status colors without having to collapse +
    // re-expand manually.
    effect(() => {
      const token = this.refreshToken();
      if (this.expanded() && this.loadedAt !== token && !this.loading()) {
        void this.ensureChildren();
      }
    });
  }

  onRowClick(): void {
    const n = this.node();
    if (n.isDir) {
      const next = !this.expanded();
      this.expanded.set(next);
      if (next) void this.ensureChildren();
    } else {
      this.fileOpen.emit(n.path);
    }
  }

  private async ensureChildren(): Promise<void> {
    if (this.loading()) return;
    if (this.loadedAt === this.refreshToken() && this.children().length > 0) return;
    const tokenAtStart = this.refreshToken();
    this.loading.set(true);
    this.error.set(false);
    try {
      const result = await this.api.listProjectTree(
        this.project(), this.node().path, tokenAtStart > 0,
      );
      this.children.set(result.children);
      this.loadedAt = tokenAtStart;
    } catch {
      this.error.set(true);
    } finally {
      this.loading.set(false);
    }
  }
}
