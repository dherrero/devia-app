import {
  ChangeDetectionStrategy, Component, computed, effect, inject, input, viewChild, ElementRef,
} from '@angular/core';
import { ButtonComponent, IconComponent, TooltipDirective } from '@devia/ui';
import {
  LucidePlay, LucideSquare, LucideScrollText, LucideTrash2, LucideInfo, LucideSearch, LucideLoader,
} from '@lucide/angular';
import { TranslateModule } from '@ngx-translate/core';

import { DockerStateService } from './services/docker-state.service';

/**
 * Right-rail Docker Compose panel. Header exposes play (deploy =
 * `up -d --build`), stop (`down`) and a logs refresh; the body streams
 * the command output.
 *
 * The rail icon is gated by host Docker availability; the run actions
 * here are additionally gated by the project actually having a compose
 * file. When none is found at the root, the actions are disabled and the
 * panel offers a deep search (some apps keep compose in a subfolder).
 */
@Component({
  selector: 'ds-docker-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, IconComponent, TranslateModule, TooltipDirective],
  templateUrl: './docker-panel.component.html',
  styleUrl: './docker-panel.component.scss',
})
export class DockerPanelComponent {
  readonly LucidePlay = LucidePlay;
  readonly LucideSquare = LucideSquare;
  readonly LucideScrollText = LucideScrollText;
  readonly LucideTrash2 = LucideTrash2;
  readonly LucideInfo = LucideInfo;
  readonly LucideSearch = LucideSearch;
  readonly LucideLoader = LucideLoader;

  private readonly docker = inject(DockerStateService);
  readonly project = input.required<string>();

  private readonly body = viewChild<ElementRef<HTMLDivElement>>('body');

  readonly state = computed(() => this.docker.state(this.project()));
  readonly canRun = computed(() => {
    const s = this.state();
    return s.detected && s.composeFile !== null && s.running === null;
  });

  constructor() {
    // Detect the project's compose file when the active project changes.
    effect(() => {
      const p = this.project();
      if (p) void this.docker.detect(p);
    });
    // Auto-scroll to the latest output as the log grows.
    effect(() => {
      void this.state().log; // track
      const el = this.body()?.nativeElement;
      if (el) requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
    });
  }

  run(action: 'deploy' | 'down' | 'logs'): void {
    this.docker.run(this.project(), action);
  }

  search(): void {
    this.docker.search(this.project());
  }

  clear(): void {
    this.docker.clear(this.project());
  }
}
