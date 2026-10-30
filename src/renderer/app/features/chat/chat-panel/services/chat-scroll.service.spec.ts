import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { ChatScrollService } from './chat-scroll.service';

function makeService(): ChatScrollService {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [ChatScrollService] });
  return TestBed.inject(ChatScrollService);
}

/** Build a fake scroll container with controllable geometry. jsdom
 *  doesn't run layout, so we expose the three numbers `markFromScroll`
 *  needs as plain properties via Object.defineProperty so reads return
 *  the configured values. */
function fakeContainer(opts: {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}): HTMLElement {
  const el = document.createElement('div');
  Object.defineProperty(el, 'scrollHeight', {
    get: () => opts.scrollHeight,
    configurable: true,
  });
  Object.defineProperty(el, 'scrollTop', {
    get: () => opts.scrollTop,
    set: (v: number) => {
      opts.scrollTop = v;
    },
    configurable: true,
  });
  Object.defineProperty(el, 'clientHeight', {
    get: () => opts.clientHeight,
    configurable: true,
  });
  return el;
}

describe('ChatScrollService (HT-CH-01)', () => {
  let svc: ChatScrollService;

  beforeEach(() => {
    svc = makeService();
  });

  describe('initial state', () => {
    it('starts with follow engaged and no FAB', () => {
      expect(svc.stickToBottom()).toBe(true);
      expect(svc.showScrollFab()).toBe(false);
    });
  });

  describe('isNearBottom', () => {
    it('returns true when the gap is below the slack', () => {
      const el = fakeContainer({ scrollHeight: 1000, scrollTop: 900, clientHeight: 100 });
      // distance = 0 → < 120 → near bottom
      expect(svc.isNearBottom(el)).toBe(true);
    });

    it('returns false when the user scrolled noticeably up', () => {
      const el = fakeContainer({ scrollHeight: 1000, scrollTop: 0, clientHeight: 100 });
      // distance = 900 → way past 120
      expect(svc.isNearBottom(el)).toBe(false);
    });

    it('returns true defensively for a missing element', () => {
      expect(svc.isNearBottom(null)).toBe(true);
    });
  });

  describe('markFromScroll', () => {
    it('engages follow + hides FAB when the user scrolled near the bottom', () => {
      const el = fakeContainer({ scrollHeight: 1000, scrollTop: 900, clientHeight: 100 });
      svc.markFromScroll(el);
      expect(svc.stickToBottom()).toBe(true);
      expect(svc.showScrollFab()).toBe(false);
    });

    it('disengages follow + shows FAB when the user scrolls up past the threshold', () => {
      const el = fakeContainer({ scrollHeight: 2000, scrollTop: 0, clientHeight: 100 });
      // distance = 1900 → over 200, FAB on
      svc.markFromScroll(el);
      expect(svc.stickToBottom()).toBe(false);
      expect(svc.showScrollFab()).toBe(true);
    });

    it('keeps the FAB hidden in the grey zone between slack and threshold', () => {
      // distance = 150 → over 120 (follow off) but under 200 (FAB off)
      const el = fakeContainer({ scrollHeight: 1000, scrollTop: 750, clientHeight: 100 });
      svc.markFromScroll(el);
      expect(svc.stickToBottom()).toBe(false);
      expect(svc.showScrollFab()).toBe(false);
    });
  });

  describe('computeFab', () => {
    it('shows the FAB when distance > SCROLL_FAB_THRESHOLD_PX', () => {
      const el = fakeContainer({ scrollHeight: 2000, scrollTop: 0, clientHeight: 100 });
      svc.computeFab(el);
      expect(svc.showScrollFab()).toBe(true);
    });

    it('hides the FAB on a missing element', () => {
      // Force the flag on first via a real container, then null.
      const el = fakeContainer({ scrollHeight: 2000, scrollTop: 0, clientHeight: 100 });
      svc.computeFab(el);
      expect(svc.showScrollFab()).toBe(true);
      svc.computeFab(null);
      expect(svc.showScrollFab()).toBe(false);
    });
  });

  describe('pin', () => {
    it('sets scrollTop to scrollHeight and re-engages follow', () => {
      const opts = { scrollHeight: 1500, scrollTop: 0, clientHeight: 100 };
      const el = fakeContainer(opts);
      svc.markFromScroll(el); // off
      expect(svc.stickToBottom()).toBe(false);
      svc.pin(el);
      expect(svc.stickToBottom()).toBe(true);
      expect(opts.scrollTop).toBe(1500);
    });

    it('is a no-op (still re-engages follow) when the element is missing', () => {
      svc.markFromScroll(
        fakeContainer({ scrollHeight: 2000, scrollTop: 0, clientHeight: 100 }),
      );
      expect(svc.stickToBottom()).toBe(false);
      svc.pin(null);
      expect(svc.stickToBottom()).toBe(true);
    });
  });

  describe('reengageFollow', () => {
    it('flips the intent without touching the FAB', () => {
      // Force both flags into the disengaged state.
      svc.markFromScroll(
        fakeContainer({ scrollHeight: 2000, scrollTop: 0, clientHeight: 100 }),
      );
      expect(svc.stickToBottom()).toBe(false);
      expect(svc.showScrollFab()).toBe(true);
      svc.reengageFollow();
      expect(svc.stickToBottom()).toBe(true);
      // FAB stays — the messages haven't moved.
      expect(svc.showScrollFab()).toBe(true);
    });
  });

  describe('setContainer + no-arg overloads (HT-CH-03)', () => {
    it('exposes the registered container via the read-only signal', () => {
      const el = fakeContainer({ scrollHeight: 100, scrollTop: 0, clientHeight: 50 });
      expect(svc.container()).toBeNull();
      svc.setContainer(el);
      expect(svc.container()).toBe(el);
      svc.setContainer(null);
      expect(svc.container()).toBeNull();
    });

    it('pin() (no arg) uses the registered container', () => {
      const opts = { scrollHeight: 1500, scrollTop: 0, clientHeight: 100 };
      const el = fakeContainer(opts);
      svc.setContainer(el);
      svc.markFromScroll(el); // disengage follow
      expect(svc.stickToBottom()).toBe(false);
      svc.pin();
      expect(svc.stickToBottom()).toBe(true);
      expect(opts.scrollTop).toBe(1500);
    });

    it('pin() (no arg) with no registered container only flips intent', () => {
      svc.markFromScroll(
        fakeContainer({ scrollHeight: 2000, scrollTop: 0, clientHeight: 100 }),
      );
      expect(svc.stickToBottom()).toBe(false);
      svc.pin();
      expect(svc.stickToBottom()).toBe(true);
    });

    it('markFromScroll() and computeFab() (no arg) read the registered container', () => {
      const el = fakeContainer({ scrollHeight: 2000, scrollTop: 0, clientHeight: 100 });
      svc.setContainer(el);
      svc.markFromScroll();
      expect(svc.stickToBottom()).toBe(false);
      expect(svc.showScrollFab()).toBe(true);
      // Move "the user" near the bottom and re-mark.
      Object.defineProperty(el, 'scrollTop', { get: () => 1900, configurable: true });
      svc.markFromScroll();
      expect(svc.stickToBottom()).toBe(true);
    });

    it('isNearBottom() (no arg) defaults to true when nothing is registered', () => {
      expect(svc.isNearBottom()).toBe(true);
    });

    it('pinSmooth() (no arg) calls scrollTo on the registered container', () => {
      const el = fakeContainer({ scrollHeight: 1500, scrollTop: 0, clientHeight: 100 });
      const scrollToSpy = vi.fn();
      (el as unknown as { scrollTo: typeof scrollToSpy }).scrollTo = scrollToSpy;
      svc.setContainer(el);
      svc.pinSmooth();
      expect(scrollToSpy).toHaveBeenCalledWith({ top: 1500, behavior: 'smooth' });
      expect(svc.showScrollFab()).toBe(false);
    });
  });

  // ── Instance isolation (T-147) ────────────────────────────────────────
  // Two independent instances (one per chat panel in split-view) must
  // never share scroll state — registering a container on A must not
  // affect B, and re-engaging follow on A must not flip B.
  describe('instance isolation', () => {
    it('setContainer on A does not affect B', () => {
      const a = new ChatScrollService();
      const b = new ChatScrollService();
      const el = fakeContainer({ scrollHeight: 1000, scrollTop: 0, clientHeight: 100 });
      a.setContainer(el);
      expect(a.container()).toBe(el);
      expect(b.container()).toBeNull();
    });

    it('reengageFollow on A does not affect B', () => {
      const a = new ChatScrollService();
      const b = new ChatScrollService();
      // Disengage follow on both, then re-engage only A.
      const el = fakeContainer({ scrollHeight: 2000, scrollTop: 0, clientHeight: 100 });
      a.markFromScroll(el);
      b.markFromScroll(el);
      expect(a.stickToBottom()).toBe(false);
      expect(b.stickToBottom()).toBe(false);
      a.reengageFollow();
      expect(a.stickToBottom()).toBe(true);
      expect(b.stickToBottom()).toBe(false);
    });
  });
});
