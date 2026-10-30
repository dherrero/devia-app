import { Directive, ElementRef, afterNextRender, inject, input } from '@angular/core';

/**
 * Reveals the host element's text content character by character once, like a
 * typewriter, right after it first renders.
 *
 * Used to animate a finished agent message appearing: the raw markdown is
 * hidden while the agent streams, and the formatted result "types itself in"
 * on completion. Walks the element's text nodes in document order and restores
 * their text progressively over a fixed frame budget, so short and long replies
 * both feel snappy. Honours `prefers-reduced-motion` and skips very long
 * content (shows it instantly) so it never feels sluggish.
 *
 * Pure DOM mutation against the already-rendered innerHTML — no change
 * detection, no NgZone, no async/await. When `[dsTypewriter]` is false the host
 * is left untouched (history messages render instantly).
 */
@Directive({
  selector: '[dsTypewriter]',
  standalone: true,
})
export class TypewriterDirective {
  /** Animate on first render when true; show instantly when false. */
  readonly active = input(false, { alias: 'dsTypewriter' });

  /** ~1.3s at 60fps — constant duration regardless of length (within cap). */
  private static readonly FRAMES = 80;
  /** Longer replies skip the animation and render instantly. */
  private static readonly MAX_CHARS = 4000;

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private started = false;

  constructor() {
    afterNextRender(() => {
      if (this.started || !this.active()) return;
      this.started = true;
      this.run();
    });
  }

  private prefersReducedMotion(): boolean {
    return (
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    );
  }

  private run(): void {
    const walker = document.createTreeWalker(this.host.nativeElement, NodeFilter.SHOW_TEXT);
    const nodes: { node: Text; full: string }[] = [];
    let total = 0;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = n as Text;
      const full = text.textContent ?? '';
      nodes.push({ node: text, full });
      total += full.length;
    }
    if (total === 0) return;
    if (this.prefersReducedMotion() || total > TypewriterDirective.MAX_CHARS) return;

    for (const entry of nodes) entry.node.textContent = '';
    const perFrame = Math.max(1, Math.ceil(total / TypewriterDirective.FRAMES));

    let i = 0;
    let pos = 0;
    const step = (): void => {
      let budget = perFrame;
      while (budget > 0 && i < nodes.length) {
        const entry = nodes[i];
        const take = Math.min(budget, entry.full.length - pos);
        pos += take;
        budget -= take;
        entry.node.textContent = entry.full.slice(0, pos);
        if (pos >= entry.full.length) {
          i++;
          pos = 0;
        }
      }
      if (i < nodes.length) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
}
