import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import { ButtonComponent } from '@devia/ui';
import { TranslateModule } from '@ngx-translate/core';

import type { ProjectTreeNode } from '../../../../../../shared/domain/project-tree';
import type { PickInput, PickResult } from '../../../../../../shared/domain/ui-tools';
import { ElectronApiService } from '../../../../core/services/electron-api.service';

/**
 * File/directory picker asked for by the agent through `devia_pick`
 * (S-25 F2.5).
 *
 * Browses the project tree one level at a time through the same IPC the
 * right-rail browser uses. Selection state is kept by RELATIVE path, which is
 * also what goes back to the agent: an absolute host path must never leave
 * the app.
 */
@Component({
  selector: 'ds-ui-pick-card',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, TranslateModule],
  templateUrl: './ui-pick-card.component.html',
  styleUrl: './ui-pick-card.component.scss',
})
export class UiPickCardComponent {
  private readonly api = inject(ElectronApiService);

  readonly input = input.required<unknown>();
  /** The checkout the run is against — the tree is browsed relative to it. */
  readonly project = input.required<string>();
  readonly decided = output<PickResult>();

  protected readonly pick = computed<PickInput>(() => (this.input() as PickInput | null) ?? {});
  protected readonly multiple = computed(() => this.pick().multiple === true);
  protected readonly filter = computed(() => this.pick().filter ?? 'any');

  protected readonly cwd = signal('');
  protected readonly children = signal<ProjectTreeNode[]>([]);
  protected readonly selected = signal<readonly string[]>([]);
  protected readonly loading = signal(false);

  protected readonly canSend = computed(() => this.selected().length > 0);

  /** Entries the agent asked for; directories always show so the user can descend. */
  protected readonly visible = computed(() => {
    const filter = this.filter();
    return this.children().filter((node) => node.isDir || filter !== 'dir');
  });

  constructor() {
    queueMicrotask(() => void this.browse(this.pick().root ?? ''));
  }

  protected async browse(subPath: string): Promise<void> {
    this.loading.set(true);
    try {
      const result = await this.api.listProjectTree(this.project(), subPath);
      this.cwd.set(result.subPath);
      this.children.set(result.children);
    } catch {
      // A root the agent invented, or a directory that vanished: fall back to
      // the project root rather than leaving the card empty and unusable.
      if (subPath) return void this.browse('');
      this.children.set([]);
    } finally {
      this.loading.set(false);
    }
  }

  protected up(): void {
    const cwd = this.cwd();
    if (!cwd) return;
    const parent = cwd.includes('/') ? cwd.slice(0, cwd.lastIndexOf('/')) : '';
    void this.browse(parent);
  }

  protected isSelectable(node: ProjectTreeNode): boolean {
    const filter = this.filter();
    if (filter === 'dir') return node.isDir;
    if (filter === 'file') return !node.isDir;
    return true;
  }

  protected isSelected(node: ProjectTreeNode): boolean {
    return this.selected().includes(node.path);
  }

  protected toggle(node: ProjectTreeNode): void {
    if (!this.isSelectable(node)) return;
    const current = this.selected();
    if (current.includes(node.path)) {
      this.selected.set(current.filter((p) => p !== node.path));
      return;
    }
    this.selected.set(this.multiple() ? [...current, node.path] : [node.path]);
  }

  protected send(): void {
    this.decided.emit({ paths: [...this.selected()] });
  }

  protected cancel(): void {
    this.decided.emit({ paths: [] });
  }
}
