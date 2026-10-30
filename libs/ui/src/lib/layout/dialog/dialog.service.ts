import { inject, Injectable } from '@angular/core';
import { Dialog, DialogRef, DIALOG_DATA } from '@angular/cdk/dialog';
import { ComponentType } from '@angular/cdk/overlay';
import { map } from 'rxjs';
import type { Observable } from 'rxjs';
import { DialogComponent } from './component';
import { DialogData, DialogResult } from './dialog.interfaces';

export { DialogRef, DIALOG_DATA };

@Injectable({ providedIn: 'root' })
export class DialogService {
  private readonly dialog = inject(Dialog);

  open<TResult = unknown, TData = unknown>(
    component: ComponentType<unknown>,
    data?: TData,
  ): DialogRef<DialogResult<TResult>> {
    return this.dialog.open<DialogResult<TResult>>(component, {
      data,
      backdropClass: 'dv-dialog-backdrop',
      panelClass: 'dv-dialog-panel',
      autoFocus: 'first-tabbable',
      restoreFocus: true,
    });
  }

  openDrawer<TResult = unknown, TData = unknown>(
    component: ComponentType<unknown>,
    data?: TData,
  ): DialogRef<TResult> {
    return this.dialog.open<TResult>(component, {
      data,
      backdropClass: 'dv-dialog-backdrop',
      panelClass: 'dv-dialog-panel--drawer',
      autoFocus: 'first-tabbable',
      restoreFocus: true,
      hasBackdrop: true,
      width: '100%',
      height: '100%',
      maxWidth: '100%',
      maxHeight: '100%',
    });
  }

  confirm(options: {
    title?: string;
    message: string;
    confirmLabel?: string;
    cancelLabel?: string;
    danger?: boolean;
  }): Observable<boolean> {
    const ref = this.dialog.open<DialogResult>(DialogComponent, {
      data: {
        title: options.title,
        message: options.message,
        confirmLabel: options.confirmLabel ?? 'Confirmar',
        cancelLabel: options.cancelLabel ?? 'Cancelar',
        danger: options.danger ?? false,
        disableClose: false,
      } satisfies DialogData,
      backdropClass: 'dv-dialog-backdrop',
      panelClass: 'dv-dialog-panel',
      autoFocus: 'first-tabbable',
      restoreFocus: true,
    });
    return ref.closed.pipe(map((result) => result?.action === 'confirm'));
  }
}
