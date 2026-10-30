import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import { ButtonComponent, IconComponent } from '@devia/ui';
import {
  LucideArrowRight, LucideCircleCheck, LucideCircleX, LucideInfo, LucideTriangleAlert, LucideX,
  type LucideIcon,
} from '@lucide/angular';
import { Toast, ToastService } from '../../core/services/toast.service';

@Component({
  selector: 'ds-toasts',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, IconComponent, TranslateModule],
  templateUrl: './toasts.component.html',
  styleUrl: './toasts.component.scss',
})
export class ToastsComponent {
  readonly LucideArrowRight = LucideArrowRight;
  readonly LucideX = LucideX;

  readonly toasts = inject(ToastService);

  onClick(t: Toast) {
    if (!t.onClick) return;
    try { t.onClick(); } catch (err) { console.error('[toast] onClick:', err); }
    this.toasts.dismiss(t.id);
  }

  onAction(t: Toast) {
    if (!t.action) return;
    try { t.action.onAction(); } catch (err) { console.error('[toast] action:', err); }
    this.toasts.dismiss(t.id);
  }

  iconLucideFor(kind: Toast['kind']): LucideIcon {
    switch (kind) {
      case 'success': return LucideCircleCheck;
      case 'warning': return LucideTriangleAlert;
      case 'error':   return LucideCircleX;
      default:        return LucideInfo;
    }
  }
}
