import { Injectable, signal } from '@angular/core';

export type ToastKind = 'info' | 'success' | 'warning' | 'error';

export interface Toast {
  id: string;
  text: string;
  kind: ToastKind;
  /** Fired when the user clicks the toast body. The toast is dismissed
   *  right after, regardless of whether onClick is set. */
  onClick?: () => void;
  /** Optional explicit action button (S-2 F3.4). Independent from onClick:
   *  the button fires `onAction` and dismisses; the body stays inert. */
  action?: { label: string; onAction: () => void };
}

// Tiny stackable toast queue. The app-level snackbar shows one notification
// at a time and only queues sequentially — we want them to stack visually so
// multiple parallel-running projects can each report when they finish.
@Injectable({ providedIn: 'root' })
export class ToastService {
  readonly toasts = signal<Toast[]>([]);

  show(text: string, opts: {
    kind?: ToastKind;
    durationMs?: number;
    onClick?: () => void;
    action?: Toast['action'];
  } = {}) {
    const id = crypto.randomUUID();
    const kind = opts.kind ?? 'success';
    this.toasts.update((list) => [
      ...list,
      {
        id,
        text,
        kind,
        ...(opts.onClick !== undefined && { onClick: opts.onClick }),
        ...(opts.action !== undefined && { action: opts.action }),
      },
    ]);
    setTimeout(() => this.dismiss(id), opts.durationMs ?? 5000);
  }

  dismiss(id: string) {
    this.toasts.update((list) => list.filter((t) => t.id !== id));
  }
}
