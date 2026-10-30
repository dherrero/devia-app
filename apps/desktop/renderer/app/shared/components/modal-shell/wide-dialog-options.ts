/** @deprecated Use DIALOG_SIZE_FULL. Kept as alias while right-rail migrates (DSK-F1). */
export const WIDE_DIALOG_OPTIONS = {
  width: '90vw',
  maxWidth: '1400px',
  height: '85vh',
  maxHeight: '85vh',
  panelClass: 'dv-dialog-panel',
  backdropClass: 'dv-dialog-backdrop',
  autoFocus: 'first-tabbable' as const,
  restoreFocus: true,
};

export const DIALOG_SIZE_WIDE = {
  width: '80vw',
  maxWidth: '80vw',
  panelClass: 'dv-dialog-panel',
  backdropClass: 'dv-dialog-backdrop',
  autoFocus: 'first-tabbable' as const,
  restoreFocus: true,
};

export const DIALOG_SIZE_MEDIUM = {
  width: '560px',
  maxWidth: '95vw',
  panelClass: 'dv-dialog-panel',
  backdropClass: 'dv-dialog-backdrop',
  autoFocus: 'first-tabbable' as const,
  restoreFocus: true,
};

export const DIALOG_SIZE_FULL = {
  width: '90vw',
  maxWidth: '1400px',
  height: '85vh',
  maxHeight: '85vh',
  panelClass: 'dv-dialog-panel',
  backdropClass: 'dv-dialog-backdrop',
  autoFocus: 'first-tabbable' as const,
  restoreFocus: true,
};
