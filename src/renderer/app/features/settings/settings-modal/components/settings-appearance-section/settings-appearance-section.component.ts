import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ToggleComponent } from '@devia/ui';

/**
 * Pure presentational appearance picker. The parent owns the theme/style
 * application (setTheme/setStyle + revert-on-close); this component only
 * reflects the current state and emits the user's choice.
 */
@Component({
  selector: 'ds-settings-appearance-section',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, ToggleComponent],
  templateUrl: './settings-appearance-section.component.html',
  styleUrl: './settings-appearance-section.component.scss',
})
export class SettingsAppearanceSectionComponent {
  readonly isDark = input(false);
  readonly isSharp = input(false);

  readonly themeSelected = output<'light' | 'dark'>();
  readonly styleSelected = output<'rounded' | 'sharp'>();

  selectPreset(theme: 'light' | 'dark', style: 'rounded' | 'sharp'): void {
    this.themeSelected.emit(theme);
    this.styleSelected.emit(style);
  }
}
