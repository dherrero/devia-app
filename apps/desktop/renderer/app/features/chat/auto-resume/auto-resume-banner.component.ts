import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import { ButtonComponent } from '@devia/ui';
import { AppStateService } from '../../../core/services/app-state.service';
import { ElectronApiService } from '../../../core/services/electron-api.service';

/**
 * Shown while Devia waits for the account's usage limit to reset in order to
 * continue the session by itself. Without it a paused session would look hung.
 */
@Component({
  selector: 'ds-auto-resume-banner',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, TranslateModule],
  templateUrl: './auto-resume-banner.component.html',
  styleUrl: './auto-resume-banner.component.scss',
})
export class AutoResumeBannerComponent {
  private readonly state = inject(AppStateService);
  private readonly api = inject(ElectronApiService);

  readonly sessionKey = input.required<string>();

  readonly time = computed(() => {
    const fireAt = this.state.autoResumes().get(this.sessionKey());
    if (fireAt === undefined) return null;
    const at = new Date(fireAt);
    const time = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    // A weekly window reopens days from now: "13:20" alone would read as today.
    return at.toDateString() === new Date().toDateString()
      ? time
      : `${at.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })} ${time}`;
  });

  cancel(): void {
    void this.api.cancelAutoResume(this.sessionKey());
  }
}
