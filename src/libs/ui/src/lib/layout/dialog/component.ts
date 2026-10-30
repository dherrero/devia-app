import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { DialogRef, DIALOG_DATA } from '@angular/cdk/dialog';
import { ButtonComponent } from '../../forms/button/component';
import { DialogData, DialogResult } from './dialog.interfaces';

@Component({
  selector: 'dv-dialog',
  templateUrl: './component.html',
  styleUrl: './component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent],
  host: {
    class: 'dv-dialog',
    'aria-modal': 'true',
    '[attr.role]': `data?.variant === 'alert' ? 'alertdialog' : 'dialog'`,
  },
})
export class DialogComponent {
  protected readonly ref = inject<DialogRef<DialogResult>>(DialogRef);
  protected readonly data: DialogData =
    inject(DIALOG_DATA, { optional: true }) ?? {};

  protected get hasActions(): boolean {
    return !!(
      this.data.message ||
      this.data.confirmLabel ||
      this.data.cancelLabel
    );
  }

  close(result: DialogResult): void {
    this.ref.close(result);
  }

  dismiss(): void {
    if (!this.data.disableClose) this.ref.close({ action: 'dismiss' });
  }
}
