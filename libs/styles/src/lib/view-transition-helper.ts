export function runViewTransition(update: () => void): void {
  const doc = document as Document & {
    startViewTransition?: (callback: () => void) => void;
  };

  if (doc.startViewTransition) {
    doc.startViewTransition(update);
    return;
  }

  update();
}
