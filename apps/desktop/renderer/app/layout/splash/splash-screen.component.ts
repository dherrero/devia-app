import {
  ChangeDetectionStrategy,
  Component,
  inject,
  signal,
  effect,
} from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import { AppStateService } from '../../core/services/app-state.service';

@Component({
  selector: 'ds-splash-screen',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslateModule],
  templateUrl: './splash-screen.component.html',
  styleUrl: './splash-screen.component.scss',
})
export class SplashScreenComponent {
  private readonly state = inject(AppStateService);

  /** True once the exit animation should begin (appReady is true). */
  readonly leaving = signal(false);

  constructor() {
    effect(() => {
      if (this.state.appReady()) {
        this.leaving.set(true);
      }
    });
  }
}
