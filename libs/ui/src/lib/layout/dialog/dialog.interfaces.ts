export interface DialogData {
  title?: string;
  subtitle?: string;
  message?: string;
  variant?: 'default' | 'alert';
  disableClose?: boolean;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

export interface DialogResult<T = unknown> {
  action: 'confirm' | 'cancel' | 'dismiss';
  value?: T;
}
