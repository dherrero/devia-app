import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { ToastItemComponent } from '../toast.component';
import { ToastService } from '../toast.service';

@Component({
  selector: 'dv-toast-host',
  standalone: true,
  imports: [ToastItemComponent],
  templateUrl: './toast-host.component.html',
  styleUrl: './toast-host.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ToastHostComponent {
  protected readonly toastService = inject(ToastService);
}
