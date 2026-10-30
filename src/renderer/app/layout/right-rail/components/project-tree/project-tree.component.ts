import {
  ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, input, signal,
} from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import {
  ButtonComponent, IconComponent, MenuComponent, TooltipDirective, type MenuItemDef,
} from '@devia/ui';
import {
  LucideFolderOpen, LucideCode, LucideChevronDown, LucideCopy, LucideRefreshCw,
} from '@lucide/angular';
import type { ProjectTreeNode } from '../../../../../../shared/domain/project-tree';
import type { IdeId, IdeInfo } from '../../../../../../shared/domain/ide';
import { AppStateService } from '../../../../core/services/app-state.service';
import { ElectronApiService } from '../../../../core/services/electron-api.service';
import { MenuTriggerButtonComponent } from '../../../../shared/components/menu-trigger-button/menu-trigger-button.component';
import { TreeNodeComponent } from './components/tree-node/tree-node.component';

/** Brand icons for the IDEs that ship one. Missing ids fall back to the
 *  generic `code` glyph in the template. */
const IDE_ICON: Partial<Record<IdeId, string>> = {
  vscode:           'assets/icons/ide/vscode.svg',
  cursor:           'assets/icons/ide/cursor.svg',
  windsurf:         'assets/icons/ide/windsurf.svg',
  zed:              'assets/icons/ide/zed.svg',
  sublime:          'assets/icons/ide/sublime.svg',
  intellij:         'assets/icons/ide/intellij.svg',
  webstorm:         'assets/icons/ide/webstorm.svg',
  pycharm:          'assets/icons/ide/pycharm.svg',
  'android-studio': 'assets/icons/ide/android-studio.svg',
  xcode:            'assets/icons/ide/xcode.png',
};

/**
 * Read-only file explorer that mirrors the project's filesystem with a
 * git status overlay (modified/added/untracked/deleted/renamed). Listing
 * is lazy: only the root is loaded eagerly, each folder fetches its own
 * children on first expand.
 *
 * Refresh triggers:
 *  - project change           → full reset
 *  - manual refresh button    → bump refreshToken, force-bypass cache
 *  - process:end              → same as manual (agent edits files)
 *  - git:info-changed         → same as manual (branch/dirty state moved)
 *
 * Stale-data window: a tracked file edited in an external editor with no
 * git activity afterwards will not refresh until the next process:end or
 * manual click. Acceptable for v1 — users overwhelmingly modify via the
 * agent or via Devia's own terminal, both of which fire process:end.
 */
@Component({
  selector: 'ds-project-tree',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, IconComponent, MenuComponent, MenuTriggerButtonComponent, TooltipDirective, TranslateModule, TreeNodeComponent],
  templateUrl: './project-tree.component.html',
  styleUrl: './project-tree.component.scss',
})
export class ProjectTreeComponent {
  readonly LucideFolderOpen = LucideFolderOpen;
  readonly LucideCode = LucideCode;
  readonly LucideChevronDown = LucideChevronDown;
  readonly LucideCopy = LucideCopy;
  readonly LucideRefreshCw = LucideRefreshCw;

  readonly project = input.required<string>();

  private readonly api = inject(ElectronApiService);
  private readonly state = inject(AppStateService);
  private readonly destroyRef = inject(DestroyRef);

  readonly roots = signal<ProjectTreeNode[]>([]);
  readonly loading = signal(false);
  readonly error = signal(false);
  /** Monotonic counter passed down to tree-nodes; bumping it invalidates
   *  their cached children + tells them to force-refresh the next list()
   *  call (bypasses the per-project status cache in the main process). */
  readonly refreshToken = signal(0);

  // ── IDE selector ─────────────────────────────────────────────────────────
  // Installed IDEs (detected once, main-side) + the user's preferred choice,
  // persisted so the split-button reopens the same IDE next time.
  private readonly PREFERRED_IDE_KEY = 'devia:tree:preferredIde';
  readonly ides = signal<IdeInfo[]>([]);
  readonly preferredIde = signal<IdeId | null>(this.loadPreferredIde());
  readonly preferredIdeLabel = computed(() => {
    const id = this.preferredIde();
    const list = this.ides();
    return list.find((i) => i.id === id)?.label ?? list[0]?.label ?? '';
  });
  readonly preferredIdeIcon = computed(() => {
    const id = this.preferredIde() ?? this.ides()[0]?.id;
    return id ? IDE_ICON[id] : undefined;
  });

  readonly ideMenuItems = computed<MenuItemDef[]>(() =>
    this.ides().map((ide) => ({
      id: ide.id,
      label: ide.label,
      ...(ide.id === this.preferredIde() ? { matIcon: 'check' } : undefined),
    }))
  );

  iconFor(id: IdeId): string | undefined { return IDE_ICON[id]; }

  onIdeMenuSelect(item: MenuItemDef): void {
    const ide = this.ides().find((i) => i.id === item.id);
    if (ide) this.openIde(ide);
  }

  constructor() {
    // Reset everything when the active project changes.
    effect(() => {
      const p = this.project();
      this.roots.set([]);
      this.refreshToken.set(0);
      if (p) void this.loadRoot(false);
    });

    // The agent or a git operation might have changed file contents and/or
    // tracked/untracked state. Force a refresh so the UI catches up
    // without the user having to click. Subscribed at component scope —
    // the listeners are unhooked when the tree leaves the DOM.
    const onChange = () => this.refresh(true);
    this.api.onProcessEnd(onChange);
    this.api.onGitInfoChanged(onChange);
    // The bridge has no removal API for these listeners, but the tree
    // panel itself is mounted at most once at a time inside the right
    // rail, so leaking the closures is bounded.
    this.destroyRef.onDestroy(() => {
      // intentional no-op (see comment above)
    });

    void this.loadIdes();
  }

  refresh(force: boolean): void {
    this.refreshToken.update((t) => t + 1);
    void this.loadRoot(force);
  }

  onFileOpen(filePath: string): void {
    this.state.focusedDiffFile.set(filePath);
  }

  /** Absolute path of the active project, mirroring the sidebar's resolution
   *  (`project()` is the workspace-relative name). */
  private absolutePath(): string {
    const root = this.state.config()?.workspaceRoot ?? '';
    const p = this.project();
    return root ? `${root}/${p}` : p;
  }

  openInExplorer(): void { void this.api.openPath(this.absolutePath()); }

  async copyPath(): Promise<void> {
    try { await navigator.clipboard.writeText(this.absolutePath()); }
    catch (err) { console.error('[clipboard]', err); }
  }

  /** Open the project in the preferred (last-used) IDE. */
  openPreferredIde(): void {
    const id = this.preferredIde() ?? this.ides()[0]?.id;
    if (id) void this.openIdeById(id);
  }

  /** Pick an IDE from the selector: remember it and open the project. */
  openIde(ide: IdeInfo): void {
    this.preferredIde.set(ide.id);
    this.savePreferredIde(ide.id);
    void this.openIdeById(ide.id);
  }

  private async openIdeById(ideId: IdeId): Promise<void> {
    try { await this.api.openInIde(this.absolutePath(), ideId); }
    catch (err) { console.error('[openInIde]', err); }
  }

  private async loadIdes(): Promise<void> {
    try {
      const list = await this.api.listIdes();
      this.ides.set(list);
      // Drop a stale stored preference (synced from another machine / IDE
      // uninstalled) so the split-button always points at something real.
      const stored = this.preferredIde();
      if (!stored || !list.some((i) => i.id === stored)) {
        this.preferredIde.set(list[0]?.id ?? null);
      }
    } catch (err) {
      console.error('[listIdes]', err);
    }
  }

  private loadPreferredIde(): IdeId | null {
    try { return (localStorage.getItem(this.PREFERRED_IDE_KEY) as IdeId | null) || null; }
    catch { return null; }
  }

  private savePreferredIde(id: IdeId): void {
    try { localStorage.setItem(this.PREFERRED_IDE_KEY, id); }
    catch { /* ignore */ }
  }

  private async loadRoot(force: boolean): Promise<void> {
    const project = this.project();
    if (!project) return;
    this.loading.set(true);
    this.error.set(false);
    try {
      const result = await this.api.listProjectTree(project, '', force);
      this.roots.set(result.children);
    } catch {
      this.error.set(true);
    } finally {
      this.loading.set(false);
    }
  }
}
