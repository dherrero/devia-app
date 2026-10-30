import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from '@angular/core';
import {
  LucideMoon,
  LucideSun,
  LucideAnchor,
  LucideFlag,
} from '@lucide/angular';
import { IconComponent } from '../../atoms/icon';
import {
  DeviaThemeValue,
  THEME_DEFINITIONS,
} from './models/theme-toggle.models';

@Component({
  selector: 'dv-theme-toggle',
  standalone: true,
  imports: [IconComponent],
  templateUrl: './component.html',
  styleUrl: './component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'dv-theme-toggle' },
})
export class ThemeToggleComponent {
  readonly theme = input<DeviaThemeValue>('dark');

  readonly lightDarkLabel = input<string | null>(null);
  readonly groupLabel = input<string | null>(null);

  readonly changed = output<DeviaThemeValue>();

  protected readonly isDark = computed(() => {
    const t = this.theme();
    return THEME_DEFINITIONS.find((th) => th.id === t)?.dark ?? false;
  });

  protected readonly isNavy = computed(() => {
    const t = this.theme();
    return THEME_DEFINITIONS.find((th) => th.id === t)?.group === 'navy';
  });

  protected readonly lightDarkIcon = computed(() =>
    this.isDark() ? LucideSun : LucideMoon,
  );

  protected readonly resolvedLightDarkLabel = computed(
    () =>
      this.lightDarkLabel() ??
      (this.isDark() ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro'),
  );

  protected readonly groupIcon = computed(() =>
    this.isNavy() ? LucideFlag : LucideAnchor,
  );

  protected readonly resolvedGroupLabel = computed(
    () =>
      this.groupLabel() ??
      (this.isNavy() ? 'Cambiar a tema Violet' : 'Cambiar a tema Navy'),
  );

  protected toggle(): void {
    const current = this.theme();
    const next: Record<DeviaThemeValue, DeviaThemeValue> = {
      light: 'dark',
      dark: 'light',
      navy: 'navy-dark',
      'navy-dark': 'navy',
    };
    this.changed.emit(next[current]);
  }

  protected switchGroup(): void {
    const current = this.theme();
    const target: Record<DeviaThemeValue, DeviaThemeValue> = {
      light: 'navy',
      dark: 'navy-dark',
      navy: 'light',
      'navy-dark': 'dark',
    };
    this.changed.emit(target[current]);
  }
}
