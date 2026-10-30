export interface ToastOptions {
  message: string;
  variant?: 'success' | 'warn' | 'danger' | 'neutral' | 'info';
  duration?: number;
}

export interface ToastRef {
  dismiss(): void;
}
