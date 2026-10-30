import { Injectable, signal } from '@angular/core';
import { ToastOptions, ToastRef } from './toast.models';

export interface InternalToast {
  id: string;
  options: ToastOptions;
  timer?: ReturnType<typeof setTimeout>;
}

@Injectable({ providedIn: 'root' })
export class ToastService {
  private readonly _toasts = signal<InternalToast[]>([]);
  private readonly maxStack = 4;

  /** Readonly view of the active toast stack — consumed by ToastHostComponent. */
  readonly toasts = this._toasts.asReadonly();

  show(options: ToastOptions): ToastRef {
    const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const toast: InternalToast = { id, options };

    this._toasts.update((list) => {
      const next = [...list, toast];
      return next.length > this.maxStack
        ? next.slice(next.length - this.maxStack)
        : next;
    });

    const duration = options.duration ?? 4000;
    if (duration > 0) {
      toast.timer = setTimeout(() => this.dismiss(id), duration);
    }

    return { dismiss: () => this.dismiss(id) };
  }

  success(
    message: string,
    opts?: Omit<ToastOptions, 'message' | 'variant'>,
  ): ToastRef {
    return this.show({ ...opts, message, variant: 'success' });
  }

  warn(
    message: string,
    opts?: Omit<ToastOptions, 'message' | 'variant'>,
  ): ToastRef {
    return this.show({ ...opts, message, variant: 'warn' });
  }

  danger(
    message: string,
    opts?: Omit<ToastOptions, 'message' | 'variant'>,
  ): ToastRef {
    return this.show({ ...opts, message, variant: 'danger' });
  }

  /** Dismiss a toast by its internal id. Called by host on (dismissed) output. */
  dismiss(id: string): void {
    this._toasts.update((list) => {
      const toast = list.find((t) => t.id === id);
      if (toast?.timer) clearTimeout(toast.timer);
      return list.filter((t) => t.id !== id);
    });
  }
}
