import { ChangeDetectionStrategy, Component, computed, inject, output } from '@angular/core';
import {
  ButtonComponent,
  IconComponent,
  MenuComponent,
  ThemeToggleComponent,
  type DeviaThemeValue,
  type MenuItemDef,
} from '@devia/ui';
import {
  LucideCircleStop,
  LucideEllipsisVertical,
  LucideInfo,
  LucideMinus,
  LucideSettings,
  LucideSlidersHorizontal,
  LucideSquare,
  LucideX,
} from '@lucide/angular';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { ElectronApiService } from '../../core/services/electron-api.service';
import { ThemeService } from '../../core/theme/theme.service';
import { RendererZoomService } from '../../core/zoom/renderer-zoom.service';
import {
  familyModeToTheme,
  themeToFamilyMode,
} from '../../core/theme/models/theme-option.model';
import { MenuTriggerButtonComponent } from '../../shared/components/menu-trigger-button/menu-trigger-button.component';

/**
 * Top window chrome (HT-TB-01).
 *
 * Five-column grid:
 * `[macOS safe zone] [center brand] [theme switcher] [kebab] [Win/Linux safe zone]`
 *
 * The whole bar is an Electron drag region (`-webkit-app-region: drag`).
 * Interactive controls opt out via `no-drag` so the user can still click them.
 */
@Component({
  selector: 'ds-titlebar',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ButtonComponent,
    IconComponent,
    MenuComponent,
    MenuTriggerButtonComponent,
    ThemeToggleComponent,
    TranslateModule,
  ],
  templateUrl: './titlebar.component.html',
  styleUrl: './titlebar.component.scss',
})
export class TitlebarComponent {
  readonly LucideEllipsisVertical = LucideEllipsisVertical;
  readonly LucideMinus = LucideMinus;
  readonly LucideSquare = LucideSquare;
  readonly LucideX = LucideX;

  readonly theme = inject(ThemeService);
  private readonly api = inject(ElectronApiService);
  private readonly translate = inject(TranslateService);
  readonly isWindows = this.api.platform === 'win32';
  private readonly zoom = inject(RendererZoomService);
  /** macOS shows the native traffic-light controls, so the renderer must NOT
   *  paint its own window buttons there (avoids a duplicate set). */
  readonly isMac = this.api.platform === 'darwin';
  readonly themeValue = computed<DeviaThemeValue>(() =>
    familyModeToTheme(this.theme.family(), this.theme.mode()),
  );

  readonly status = output<void>();
  readonly stopAll = output<void>();
  readonly editBases = output<void>();
  readonly settings = output<void>();

  /** Kebab menu items. Lucide-only since the desktop dropped the Material
   *  font (DESKTOP-AGENT-BRIEF). Labels resolve through ngx-translate. */
  get menuItems(): MenuItemDef[] {
    return [
      { id: 'status',    label: this.translate.instant('titlebar.status'),         icon: LucideInfo },
      { id: 'stop-all',  label: this.translate.instant('titlebar.stop_all'),       icon: LucideCircleStop },
      {
        id: 'zoom',
        kind: 'zoom-control',
        label: this.translate.instant('titlebar.zoom'),
        valueLabel: this.zoom.label(),
        dividerBefore: true,
        decreaseAction: {
          id: 'zoom-out',
          label: this.translate.instant('titlebar.zoom_out'),
          disabled: !this.zoom.canDecrease(),
        },
        resetAction: {
          id: 'zoom-reset',
          label: this.translate.instant('titlebar.zoom_reset'),
        },
        increaseAction: {
          id: 'zoom-in',
          label: this.translate.instant('titlebar.zoom_in'),
          disabled: !this.zoom.canIncrease(),
        },
      },
      { id: 'templates', label: this.translate.instant('titlebar.edit_templates'), icon: LucideSlidersHorizontal, dividerBefore: true },
      { id: 'settings',  label: this.translate.instant('titlebar.settings'),       icon: LucideSettings },
    ];
  }

  onMenuItem(item: MenuItemDef): void {
    switch (item.id) {
      case 'status':    this.status.emit(); break;
      case 'stop-all':  this.stopAll.emit(); break;
      case 'zoom-out':  this.zoom.decrease(); break;
      case 'zoom-reset': this.zoom.reset(); break;
      case 'zoom-in':   this.zoom.increase(); break;
      case 'templates': this.editBases.emit(); break;
      case 'settings':  this.settings.emit(); break;
    }
  }

  onThemeChanged(value: DeviaThemeValue): void {
    const { family, mode } = themeToFamilyMode(value);
    this.theme.setTheme(family, mode);
  }

  minimizeWindow(): void {
    void this.api.minimizeWindow();
  }

  toggleMaximizeWindow(): void {
    void this.api.toggleMaximizeWindow();
  }

  closeWindow(): void {
    void this.api.closeWindow();
  }
}
