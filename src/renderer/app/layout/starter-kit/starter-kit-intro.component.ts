import { ChangeDetectionStrategy, Component, effect, inject, output, signal, untracked } from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import { LucideSparkles } from '@lucide/angular';
import { ButtonComponent, IconComponent } from '@devia/ui';
import type { StarterKitView } from '../../../../shared/domain/starter-kit';
import { AppStateService } from '../../core/services/app-state.service';
import { ElectronApiService } from '../../core/services/electron-api.service';

/**
 * First-run card for the bundled Superpowers kit (S-38). A fresh install has
 * the kit ON and is told so; an existing install is never switched silently
 * and is asked instead. Either answer marks the card as seen, once.
 */
@Component({
  selector: 'ds-starter-kit-intro',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, IconComponent, TranslateModule],
  templateUrl: './starter-kit-intro.component.html',
  styleUrl: './starter-kit-intro.component.scss',
})
export class StarterKitIntroComponent {
  readonly LucideSparkles = LucideSparkles;

  private readonly api = inject(ElectronApiService);
  private readonly state = inject(AppStateService);

  readonly details = output<void>();
  readonly view = signal<StarterKitView | null>(null);

  constructor() {
    effect(() => {
      if (!this.state.appReady()) return;
      untracked(() => {
        void this.api.starterKitStatus().then((v) => {
          this.view.set(v.materialized && !v.introSeen ? v : null);
        }).catch(() => this.view.set(null));
      });
    });
  }

  async answer(enabled: boolean | null): Promise<void> {
    await this.api.setStarterKit({ id: 'superpowers', introSeen: true, ...(enabled !== null && { enabled }) });
    this.view.set(null);
  }

  more(): void {
    this.details.emit();
    void this.answer(null);
  }
}
