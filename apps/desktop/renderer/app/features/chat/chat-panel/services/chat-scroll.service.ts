import { Injectable, signal } from '@angular/core';

/**
 * Sentinel: when a method is called WITHOUT the `el` parameter it falls
 * back to the registered container set by `setContainer()`. Passing
 * `null` or `undefined` explicitly still means "no element" — the
 * argument-less form is a separate overload.
 */
type ScrollEl = HTMLElement | null | undefined;

/**
 * Auto-follow + scroll-to-latest mechanic (HT-CH-01).
 *
 * Encapsulates the two reactive flags the chat panel uses to keep the
 * viewport pinned to the freshest content without trapping the user when
 * they scroll up to read history:
 *
 * - `stickToBottom` — the user's intent. True by default and while they
 *   sit near the bottom; flips false the moment they scroll up; flips
 *   back true when they return or tap the FAB. The component re-pins on
 *   content-height changes only while this is true.
 * - `showScrollFab` — purely derived from "how far above the bottom is
 *   the scroll position", recomputed on scroll AND on content resize
 *   (growing content while scrolled up emits no scroll event).
 *
 * The service is pure logic over the two flags; the component still owns
 * the `viewChild` refs and the `ResizeObserver` lifecycle because they
 * depend on the DOM. The component calls into `pin(el)` / `pinSmooth(el)`
 * / `markFromScroll(el)` / `computeFab(el)` at the right moments.
 */
// One instance per ChatPanelComponent (component-scoped via providers[]).
// Split-view panels (T-149/T-143) each own independent scroll state.
@Injectable()
export class ChatScrollService {
  /** Pixels above the bottom edge that still flip `stickToBottom` true. */
  static readonly NEAR_BOTTOM_SLACK_PX = 120;
  /** Distance threshold past which the FAB appears. Wider than the
   *  follow-mode threshold so the button doesn't flicker for tiny scrolls. */
  static readonly SCROLL_FAB_THRESHOLD_PX = 200;

  private readonly _stickToBottom = signal(true);
  private readonly _showScrollFab = signal(false);
  private readonly _container = signal<HTMLElement | null>(null);

  readonly stickToBottom = this._stickToBottom;
  readonly showScrollFab = this._showScrollFab.asReadonly();
  /** The scroll container currently driving the FAB / follow logic, set
   *  by `setContainer()`. Exposed read-only so consumers can react to
   *  mount / unmount of the messages feed. */
  readonly container = this._container.asReadonly();

  /** Register the active scroll container. Pass `null` to detach (the
   *  messages-feed calls this on destroy). Argument-less calls to
   *  `pin()` / `pinSmooth()` etc. operate on whatever's registered. */
  setContainer(el: HTMLElement | null): void {
    this._container.set(el);
  }

  private resolve(el: ScrollEl, hasArg: boolean): HTMLElement | null {
    if (!hasArg) return this._container();
    return el ?? null;
  }

  /** Re-engage follow mode (called when the user types, taps the FAB,
   *  switches view, or first lands on a project). Use without an element
   *  to flip intent only; pass the messages container to also snap the
   *  viewport to the bottom in the same frame. */
  reengageFollow(): void {
    this._stickToBottom.set(true);
  }

  /** Pin the viewport to the bottom and re-engage follow. Cheap; safe to
   *  call from any rAF. Falls back to the registered container when
   *  called argument-less; passing `null` is a no-op (still flips intent). */
  pin(): void;
  pin(el: ScrollEl): void;
  pin(el?: ScrollEl): void {
    this._stickToBottom.set(true);
    const target = this.resolve(el, arguments.length > 0);
    if (!target) return;
    target.scrollTop = target.scrollHeight;
    this.computeFab(target);
  }

  /** Smooth-scroll variant used by the FAB click. */
  pinSmooth(): void;
  pinSmooth(el: ScrollEl): void;
  pinSmooth(el?: ScrollEl): void {
    this._stickToBottom.set(true);
    const target = this.resolve(el, arguments.length > 0);
    if (!target) return;
    target.scrollTo({ top: target.scrollHeight, behavior: 'smooth' });
    // The browser fires scroll events during the animation, so the next
    // `markFromScroll(el)` call will eventually flip the FAB off too.
    // Pre-flipping here keeps feedback snappy.
    this._showScrollFab.set(false);
  }

  /** Called from the (scroll) handler of the messages container.
   *  Updates both flags from the current scroll position. */
  markFromScroll(): void;
  markFromScroll(el: ScrollEl): void;
  markFromScroll(el?: ScrollEl): void {
    const target = this.resolve(el, arguments.length > 0);
    if (!target) return;
    this._stickToBottom.set(this.isNearBottom(target));
    this.computeFab(target);
  }

  /** Recompute only the FAB visibility (used by the ResizeObserver on
   *  content growth, where the user didn't scroll). */
  computeFab(): void;
  computeFab(el: ScrollEl): void;
  computeFab(el?: ScrollEl): void {
    const target = this.resolve(el, arguments.length > 0);
    if (!target) {
      this._showScrollFab.set(false);
      return;
    }
    const distance = target.scrollHeight - target.scrollTop - target.clientHeight;
    this._showScrollFab.set(distance > ChatScrollService.SCROLL_FAB_THRESHOLD_PX);
  }

  /** Public helper so consumers can decide whether to call `pin()` from
   *  callbacks where they need the answer (e.g. autosize input). */
  isNearBottom(): boolean;
  isNearBottom(el: ScrollEl): boolean;
  isNearBottom(el?: ScrollEl): boolean {
    const target = this.resolve(el, arguments.length > 0);
    if (!target) return true;
    return target.scrollHeight - target.scrollTop - target.clientHeight
      < ChatScrollService.NEAR_BOTTOM_SLACK_PX;
  }
}
