import {
  ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, signal, viewChild,
} from '@angular/core';
import { Dialog } from '@angular/cdk/dialog';
import { Router } from '@angular/router';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { IconComponent, TooltipDirective } from '@devia/ui';
import {
  LucideLayoutDashboard, LucidePuzzle, LucideZap, LucideUsers,
  LucideContainer, LucideFolderOpen, LucideTerminal,
} from '@lucide/angular';
import { AppStateService } from '../../core/services/app-state.service';
import { TerminalPanelComponent } from '../../features/chat/terminal/terminal-panel.component';
import { ProjectTreeComponent } from './components/project-tree/project-tree.component';
import { DockerPanelComponent } from './components/docker-panel/docker-panel.component';
import { RightRailStateService } from './services/right-rail-state.service';
import { ProjectAssetsService } from '../../core/services/project-assets.service';
import { SkillsModalComponent } from '../../features/skills/skills-modal.component';
import { NotificationCenterComponent } from '../../features/kanban/components/notification-center/notification-center.component';
import { KanbanStateService } from '../../features/kanban/services/kanban-state.service';
import { ToastService } from '../../core/services/toast.service';

/**
 * VS Code-style activity bar pinned to the right edge: a slim icon column
 * with one button per panel ("Terminal", "Arbol") and an expandable area
 * that hosts the active panel's content.
 *
 * The terminal panel stays mounted (just `[hidden]`-toggled) whenever a
 * project is selected, so the xterm scrollback survives tab switches
 * inside the rail. Closing the rail entirely (icon click on the active
 * tab) tears it down. The main-process PTY survives, but the rendered
 * scrollback does not. Acceptable tradeoff: closing the panel is a
 * deliberate user action.
 */
@Component({
  selector: 'ds-right-rail',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    TooltipDirective, IconComponent, TranslateModule,
    TerminalPanelComponent, ProjectTreeComponent, DockerPanelComponent,
    NotificationCenterComponent,
  ],
  host: {
    '[style.--dsr-panel-width.px]': 'rail.widthPx()',
  },
  templateUrl: './right-rail.component.html',
  styleUrl: './right-rail.component.scss',
})
export class RightRailComponent {
  readonly LucideLayoutDashboard = LucideLayoutDashboard;
  readonly LucidePuzzle          = LucidePuzzle;
  readonly LucideZap             = LucideZap;
  readonly LucideUsers           = LucideUsers;
  readonly LucideContainer       = LucideContainer;
  readonly LucideFolderOpen      = LucideFolderOpen;
  readonly LucideTerminal        = LucideTerminal;

  readonly state = inject(AppStateService);
  readonly rail = inject(RightRailStateService);
  readonly assets = inject(ProjectAssetsService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly dialog = inject(Dialog);
  private readonly router = inject(Router);
  private readonly kanban = inject(KanbanStateService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);

  private readonly terminalPanel = viewChild<TerminalPanelComponent>('terminal');

  private readonly viewportWidth = signal<number>(
    typeof window !== 'undefined' ? window.innerWidth : 1280,
  );

  /** Hard cap = 50% of the viewport. Matches the left sidebar's behavior
   *  so neither side can starve the chat column. */
  readonly maxWidthPx = computed(() =>
    Math.max(RightRailStateService.MIN_WIDTH_PX, Math.floor(this.viewportWidth() * 0.5)),
  );

  // Shortcuts are static. The modifier glyph depends on the host OS, not
  // the user's session. Passed into the translate pipe so the label stays
  // reactive to language changes (using translate.instant inside a computed
  // would freeze it at construction-time language).
  private readonly modKey = /Mac|iPhone|iPad/.test(navigator.platform) ? '?' : 'Ctrl';
  readonly terminalShortcut = `${this.modKey}+J`;
  readonly treeShortcut = `${this.modKey}+Shift+E`;

  constructor() {
    const onResize = () => this.viewportWidth.set(window.innerWidth);
    window.addEventListener('resize', onResize);
    this.destroyRef.onDestroy(() => window.removeEventListener('resize', onResize));

    // Re-fit + focus the terminal when the user switches into it. The
    // terminal-panel observes its host size but a hidden?visible transition
    // is not a resize, so we trigger explicitly.
    effect(() => {
      if (this.rail.activeTab() === 'terminal') {
        requestAnimationFrame(() => this.terminalPanel()?.refitAndFocus());
      }
    });

    // Clamp width when the viewport shrinks below the saved width.
    effect(() => {
      const max = this.maxWidthPx();
      if (this.rail.widthPx() > max) {
        this.rail.setWidth(max, max);
      }
    });

    // S-13 T-158: when a split turns on while the Terminal tab is active, fall
    // back to the file tree so the rail never shows an empty/headless pane.
    effect(() => {
      if (this.state.splitActive() && this.rail.activeTab() === 'terminal') {
        this.rail.openTab('tree');
      }
    });
  }

  onTab(tab: 'terminal' | 'tree' | 'docker'): void {
    this.rail.toggleTab(tab);
  }

  startDrag(event: MouseEvent): void {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = this.rail.widthPx();
    this.rail.isResizing.set(true);
    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMove = (e: MouseEvent) => {
      // Right-edge panel: dragging LEFT grows it.
      const next = startWidth + (startX - e.clientX);
      this.rail.setWidth(next, this.maxWidthPx());
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
      this.rail.isResizing.set(false);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  resetWidth(): void {
    this.rail.setWidth(RightRailStateService.DEFAULT_WIDTH_PX, this.maxWidthPx());
  }

  /** E-DSK-12 T4: open the kanban board. Lazy import so the board
   *  bundle ships in its own chunk. */
  openKanban(): void {
    const project = this.state.selectedProject();
    if (!project) return;
    // While the agent is still planning the board (started this session, no
    // tasks yet, run in flight) opening the empty board is pointless, so toast.
    const board = this.kanban.board();
    const empty = !board || (board.specs.length === 0 && board.tasks.length === 0);
    if (empty && this.kanban.isPlanning(project) && this.state.isRunning(project)) {
      this.toast.show(this.translate.instant('sdd.planning_in_progress'), {
        kind: 'info',
        durationMs: 6000,
      });
      return;
    }
    void this.router.navigateByUrl('/kanban');

  }

  openSkills(): void {
    const project = this.state.selectedProject();
    if (!project) return;
    this.dialog.open(SkillsModalComponent, {
      width: 'min(44rem, calc(100vw - 2rem))',
      height: 'min(36rem, calc(100vh - 2rem))',
      maxHeight: 'calc(100vh - 2rem)',
      panelClass: 'dv-dialog-panel',
      backdropClass: 'dv-dialog-backdrop',
      autoFocus: 'first-tabbable',
      restoreFocus: true,
      data: { project },
    });
  }

  /** #273: MCP server manager. Lazy import so the modal bundle
   *  ships in its own chunk and never lands in the main bundle. */
  openMcp(): void {
    void import('../../features/mcp/mcp-modal.component').then(({ McpModalComponent }) => {
      this.dialog.open(McpModalComponent, {
        width: 'min(44rem, calc(100vw - 2rem))',
        height: 'min(36rem, calc(100vh - 2rem))',
        maxHeight: 'calc(100vh - 2rem)',
        panelClass: 'dv-dialog-panel',
        backdropClass: 'dv-dialog-backdrop',
        autoFocus: 'first-tabbable',
        restoreFocus: true,
        data: { projectPath: this.state.selectedProject() ?? '' },
      });
    });
  }

  /** #275: Sub-agent manager. Same lazy-import pattern as MCP. */
  openSubAgents(): void {
    const project = this.state.selectedProject();
    if (!project) return;
    void import('../../features/sub-agents/sub-agents-modal.component').then(({ SubAgentsModalComponent }) => {
      this.dialog.open(SubAgentsModalComponent, {
        width: 'min(44rem, calc(100vw - 2rem))',
        height: 'min(36rem, calc(100vh - 2rem))',
        maxHeight: 'calc(100vh - 2rem)',
        panelClass: 'dv-dialog-panel',
        backdropClass: 'dv-dialog-backdrop',
        autoFocus: 'first-tabbable',
        restoreFocus: true,
        data: { projectPath: project },
      });
    });
  }
}
