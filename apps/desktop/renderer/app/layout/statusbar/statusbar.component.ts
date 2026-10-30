import { DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { ButtonComponent, DialogService, IconComponent, TooltipDirective } from '@devia/ui';
import {
  LucideArrowDownToLine,
  LucideCpu,
  LucideFolder,
  LucideGitBranch,
  LucideRefreshCw,
} from '@lucide/angular';
import { AppStateService } from '../../core/services/app-state.service';
import { ElectronApiService } from '../../core/services/electron-api.service';
import { BranchSwitcherComponent } from '../../features/git/branch-switcher/branch-switcher.component';

@Component({
  selector: 'ds-statusbar',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, DecimalPipe, IconComponent, TranslateModule, TooltipDirective],
  templateUrl: './statusbar.component.html',
  styleUrl: './statusbar.component.scss',
})
export class StatusbarComponent {
  readonly state = inject(AppStateService);
  private readonly translate = inject(TranslateService);
  private readonly dialogs = inject(DialogService);
  private readonly api = inject(ElectronApiService);
  readonly LucideArrowDownToLine = LucideArrowDownToLine;
  readonly LucideCpu = LucideCpu;
  readonly LucideFolder = LucideFolder;
  readonly LucideGitBranch = LucideGitBranch;
  readonly LucideRefreshCw = LucideRefreshCw;

  // Real running app version (synced to the release tag at build time), so the
  // footer matches the downloads page instead of a stale hardcoded string.
  readonly version = signal('');

  constructor() {
    void this.api.getAppVersion().then((v) => this.version.set(v ? `v${v}` : ''));
  }

  // Statusbar reflects the FOCUSED session's mode (T-148/T-155): the focused
  // split pane's key, or the selected project for the primary/single pane.
  readonly mode = computed(() => this.state.runMode(this.state.focusedKey() ?? ''));

  readonly modeLabel = computed(() => {
    switch (this.mode()) {
      case 'plan':       return 'mode.plan_label';
      case 'apply':      return 'mode.apply_label';
      case 'apply-yolo': return 'mode.yolo_label';
    }
  });

  readonly leafName = computed(() => {
    const p = this.state.selectedProject();
    return p ? p.split('/').pop() ?? p : '';
  });

  readonly currentRunning = computed(() => {
    const p = this.state.focusedKey();
    return p ? this.state.isRunning(p) : false;
  });

  readonly canSync = computed(() => {
    const g = this.state.gitInfo();
    return !!g && !!g.defaultBranch && g.branch !== g.defaultBranch && !g.dirty;
  });

  // The footer branch indicator is clickable only when we can safely switch the
  // BASE checkout: a project + git repo, not in split view, no agent running.
  // The authoritative guards live in AppStateService.checkoutBranch.
  readonly canSwitchBranch = computed(() => {
    const p = this.state.selectedProject();
    return !!p && !!this.state.gitInfo() && !this.state.splitActive() && !this.state.isRunning(p);
  });

  openBranchSwitcher() {
    if (!this.canSwitchBranch()) return;
    this.dialogs.open(BranchSwitcherComponent);
  }

  // The "behind N" chip becomes a one-click `git pull --ff-only` when we're
  // behind the upstream on the base checkout, not in split view, no agent
  // running. Authoritative guard lives in AppStateService.pullGit.
  readonly canPull = computed(() => {
    const p = this.state.selectedProject();
    const g = this.state.gitInfo();
    return !!p && !!g && g.behind > 0 && !this.state.splitActive() && !this.state.isRunning(p);
  });

  onPull() {
    if (!this.canPull()) return;
    void this.state.pullGit();
  }

  readonly showCost = computed<boolean>(() => (this.state.sessionCostUsd() ?? 0) > 0);

  readonly contextTooltip = computed<string>(() => {
    const used = this.state.contextUsageTokens();
    const total = this.state.contextWindowTokens();
    if (used === null || total === null) return '';
    const base = this.translate.instant('statusbar.context_tooltip', {
      used: used.toLocaleString(),
      total: total.toLocaleString(),
    });
    const compactions = this.state.compactionCount();
    if (compactions > 0) {
      return `${base} · ${this.translate.instant('statusbar.context_compactions', { count: compactions })}`;
    }
    return base;
  });

  private readonly MAX_COST_TURNS = 8;

  readonly costTooltip = computed<string>(() => {
    const turns = this.state.sessionCostTurns();
    const header = this.translate.instant('statusbar.cost_tooltip');
    if (turns.length === 0) return header;
    const recent = turns.slice(-this.MAX_COST_TURNS);
    const lines = recent.map((t) =>
      this.translate.instant('statusbar.cost_turn', {
        turn: t.turn,
        cost: t.costUsd.toFixed(2),
      }),
    );
    return [header, ...lines].join('\n');
  });

  shortModel(model: string): string {
    if (model.startsWith('claude-')) return model.slice('claude-'.length);
    if (model.startsWith('anthropic.')) return model.slice('anthropic.'.length);
    return model;
  }

  onSync() { void this.state.syncGit(); }
}
