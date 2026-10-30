import {
  ChangeDetectionStrategy, Component, ElementRef, OnDestroy, TemplateRef,
  ViewContainerRef, computed, inject, signal, viewChild,
} from '@angular/core';
import { Overlay, OverlayRef } from '@angular/cdk/overlay';
import { TemplatePortal } from '@angular/cdk/portal';
import { Dialog } from '@angular/cdk/dialog';
import {
  ButtonComponent, IconComponent, TooltipDirective,
} from '@devia/ui';
import {
  LucideBell, LucideHelpCircle, LucideCheckCircle2, LucideBlocks,
  LucideUnlock, LucideLink, LucideAlertTriangle, LucideInfo,
} from '@lucide/angular';
import { TranslateModule, TranslateService } from '@ngx-translate/core';

import { AppStateService } from '../../../../core/services/app-state.service';
import { KanbanStateService } from '../../services/kanban-state.service';
import { TicketDetailComponent } from '../ticket-detail/ticket-detail.component';
import type { SddNotification } from '../../../../../types/devia';

/**
 * Notification centre (E-DSK-12 T7). A bell button with an unread
 * badge that opens a dropdown of recent SDD notifications. Clicking a
 * task-scoped notification opens its ticket detail; opening the menu
 * marks everything read.
 *
 * Lives in the right-rail icon column. The toast + OS notification
 * paths are handled by KanbanStateService / the main process.
 */
@Component({
  selector: 'ds-notification-center',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ButtonComponent, IconComponent, TooltipDirective, TranslateModule,
  ],
  templateUrl: './notification-center.component.html',
  styleUrl: './notification-center.component.scss',
})
export class NotificationCenterComponent implements OnDestroy {
  private readonly kanban = inject(KanbanStateService);
  private readonly state = inject(AppStateService);
  private readonly dialog = inject(Dialog);
  private readonly translate = inject(TranslateService);
  private readonly overlay = inject(Overlay);
  private readonly vcr = inject(ViewContainerRef);

  private readonly triggerEl = viewChild.required<ElementRef<HTMLElement>>('triggerEl');
  private readonly panelTpl = viewChild.required<TemplateRef<void>>('panelTpl');
  private overlayRef: OverlayRef | null = null;

  readonly LucideBell = LucideBell;

  readonly isOpen = signal(false);

  readonly items = computed(() => {
    const project = this.state.selectedProject();
    const all = this.kanban.notifications();
    return project ? all.filter((n) => n.projectPath === project) : all;
  });
  readonly unread = computed(() => this.items().filter((n) => !n.read).length);
  readonly ariaLabel = computed(() =>
    this.unread() > 0
      ? this.translate.instant('sdd.notifications_with_count', { count: this.unread() })
      : this.translate.instant('sdd.notifications'),
  );

  togglePanel(): void {
    if (this.overlayRef?.hasAttached()) {
      this.closePanel();
    } else {
      this.openPanel();
    }
  }

  private openPanel(): void {
    const positionStrategy = this.overlay
      .position()
      .flexibleConnectedTo(this.triggerEl().nativeElement)
      .withPositions([
        { originX: 'end', originY: 'bottom', overlayX: 'end', overlayY: 'top', offsetY: 4 },
        { originX: 'end', originY: 'top',    overlayX: 'end', overlayY: 'bottom', offsetY: -4 },
      ]);

    this.overlayRef = this.overlay.create({
      positionStrategy,
      scrollStrategy: this.overlay.scrollStrategies.close(),
      hasBackdrop: true,
      backdropClass: 'cdk-overlay-transparent-backdrop',
    });

    this.overlayRef.backdropClick().subscribe(() => this.closePanel());
    this.overlayRef.keydownEvents().subscribe((e) => {
      if (e.key === 'Escape') this.closePanel();
    });

    const portal = new TemplatePortal(this.panelTpl(), this.vcr);
    this.overlayRef.attach(portal);
    this.isOpen.set(true);
    void this.kanban.markNotificationsRead(this.state.selectedProject() ?? undefined);
  }

  private closePanel(): void {
    this.overlayRef?.detach();
    this.overlayRef?.dispose();
    this.overlayRef = null;
    this.isOpen.set(false);
  }

  ngOnDestroy(): void {
    this.overlayRef?.dispose();
  }

  clear(): void {
    void this.kanban.clearNotifications(this.state.selectedProject() ?? undefined);
  }

  openTask(n: SddNotification): void {
    const project = this.state.selectedProject();
    if (!project || !n.taskId) return;
    this.closePanel();
    // Centered modal sizing (was a full-height side drawer).
    // Before: height: '100%', maxHeight: '100%' forced the pane to fill the
    // viewport height flush right; now the panel sizes to content, capped 90vh.
    this.dialog.open(TicketDetailComponent, {
      width: 'min(42rem, 90vw)',
      maxWidth: '90vw',
      maxHeight: '90vh',
      panelClass: ['dv-modal-panel', 'dv-ticket-drawer'],
      backdropClass: 'dv-dialog-backdrop',
      data: { project, taskId: n.taskId },
    });
  }

  titleKey(n: SddNotification): string {
    return this.kanban.notifTitleKey(n);
  }

  bodyOf(n: SddNotification): string {
    return this.kanban.notifBody(n);
  }

  icon(kind: SddNotification['kind']): typeof LucideHelpCircle | typeof LucideCheckCircle2 | typeof LucideBlocks | typeof LucideUnlock | typeof LucideLink | typeof LucideBell | typeof LucideAlertTriangle | typeof LucideInfo {
    switch (kind) {
      case 'user_input': return LucideHelpCircle;
      case 'task_done': return LucideCheckCircle2;
      case 'task_blocked': return LucideBlocks;
      case 'unblocked': return LucideUnlock;
      case 'dependency_resolved': return LucideLink;
      default: return LucideBell;
    }
  }
}
