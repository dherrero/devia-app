import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, signal, viewChild } from '@angular/core';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import {
  BadgeComponent, ButtonComponent, DialogService, IconComponent, ToggleComponent, TooltipDirective,
} from '@devia/ui';
import { LucideRefreshCw, LucideTrash2, LucideTriangleAlert } from '@lucide/angular';
import { firstValueFrom } from 'rxjs';

import type { CodeGraphLanguage, ToolUsageSummary } from '../../../../../../shared/domain/code-graph';
import { CodeGraphStateService } from '../../services/code-graph-state.service';
import { LANGUAGE_NAMES } from '../../utils/languages';
import { uiLocale } from '../../utils/locale';
import { pluralKey } from '../../utils/plural';
import { CodeGraphActionErrorComponent } from '../action-error/action-error.component';

const CLOCK_TICK_MS = 60_000;

const RELATIVE_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 31_536_000],
  ['month', 2_592_000],
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60],
];

/** Status and actions of an existing graph (`ready` / `stale`), mounted above the graph view. */
@Component({
  selector: 'ds-cg-toolbar',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    BadgeComponent, ButtonComponent, IconComponent, ToggleComponent, TooltipDirective, TranslateModule,
    CodeGraphActionErrorComponent,
  ],
  templateUrl: './graph-toolbar.component.html',
  styleUrl: './graph-toolbar.component.scss',
})
export class CodeGraphToolbarComponent {
  readonly graph = inject(CodeGraphStateService);
  private readonly translate = inject(TranslateService);
  private readonly dialogs = inject(DialogService);

  /** Clock for the relative time: ticks once a minute, which is the finest unit the text shows. */
  private readonly now = signal(Date.now());

  readonly LucideRefreshCw = LucideRefreshCw;
  readonly LucideTrash2 = LucideTrash2;
  readonly LucideTriangleAlert = LucideTriangleAlert;

  private readonly agentToggle = viewChild<ToggleComponent>('agentToggle');
  private readonly autoToggle = viewChild<ToggleComponent>('autoToggle');

  /** Reset and the switches do not raise the service's `busy`, so the toolbar tracks them itself. */
  private readonly pending = signal(false);

  readonly status = this.graph.status;
  readonly stale = computed(() => this.status()?.state === 'stale');
  readonly disabled = computed(() => this.graph.busy() || this.pending());
  readonly watchWarning = computed(() => this.graph.watchUnavailable() || this.status()?.watchDegraded === true);

  readonly languages = computed(() =>
    Object.entries(this.status()?.languages ?? {})
      .filter(([, count]) => (count ?? 0) > 0)
      .sort(([, a], [, b]) => (b ?? 0) - (a ?? 0))
      .map(([lang, count]) => ({ name: LANGUAGE_NAMES[lang as CodeGraphLanguage] ?? lang, count: count ?? 0 })),
  );

  constructor() {
    const timer = setInterval(() => this.now.set(Date.now()), CLOCK_TICK_MS);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
    effect(() => {
      const s = this.status();
      if (!s) return;
      void this.graph.refreshUsage();
      this.agentToggle()?.writeValue(s.agentAccess);
      this.autoToggle()?.writeValue(s.autoUpdate);
    });
  }

  /** Per-tool breakdown and last call, for the usage chip's tooltip. */
  usageTooltip(u: ToolUsageSummary): string {
    const tools = Object.entries(u.byTool)
      .sort(([, a], [, b]) => b - a)
      .map(([name, n]) => `${name} ${this.format(n)}`)
      .join(' · ');
    const last = u.lastAt === null ? '' : this.translate.instant('codeGraph.toolbar.usage_last', { when: this.relativeTime(u.lastAt) });
    return [tools, last].filter(Boolean).join('\n');
  }

  plural(key: string, count: number): string {
    return pluralKey(key, count);
  }

  format(n: number): string {
    return new Intl.NumberFormat(uiLocale(this.translate)).format(n);
  }

  isoTime(ms: number): string {
    return new Date(ms).toISOString();
  }

  absoluteTime(ms: number): string {
    return new Intl.DateTimeFormat(uiLocale(this.translate), { dateStyle: 'medium', timeStyle: 'short' }).format(ms);
  }

  relativeTime(ms: number): string {
    const rtf = new Intl.RelativeTimeFormat(uiLocale(this.translate), { numeric: 'auto' });
    const diffSec = Math.max(0, Math.round((this.now() - ms) / 1000));
    for (const [unit, secs] of RELATIVE_UNITS) {
      if (Math.abs(diffSec) >= secs) return rtf.format(-Math.round(diffSec / secs), unit);
    }
    return rtf.format(0, 'second');
  }

  update(): void {
    void this.graph.update();
  }

  async setAgentAccess(on: boolean): Promise<void> {
    await this.whilePending(() => this.graph.setAgentAccess(on));
    this.agentToggle()?.writeValue(this.status()?.agentAccess ?? false);
  }

  async setAutoUpdate(on: boolean): Promise<void> {
    await this.whilePending(() => this.graph.setAutoUpdate(on));
    this.autoToggle()?.writeValue(this.status()?.autoUpdate ?? false);
  }

  async confirmReset(): Promise<void> {
    const ok = await firstValueFrom(
      this.dialogs.confirm({
        title: this.translate.instant('codeGraph.reset_dialog.title'),
        message: this.translate.instant('codeGraph.reset_dialog.message'),
        confirmLabel: this.translate.instant('codeGraph.reset_dialog.confirm'),
        cancelLabel: this.translate.instant('codeGraph.reset_dialog.cancel'),
        danger: true,
      }),
    );
    if (!ok) return;
    await this.whilePending(() => this.graph.reset());
  }

  private async whilePending(action: () => Promise<void>): Promise<void> {
    this.pending.set(true);
    try {
      await action();
    } finally {
      this.pending.set(false);
    }
  }
}
