import { describe, it, expect, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { LayoutSizesService } from './layout-sizes.service';

function makeService(): LayoutSizesService {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [LayoutSizesService] });
  return TestBed.inject(LayoutSizesService);
}

describe('LayoutSizesService (HT-S-01)', () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });

  describe('hydration from localStorage', () => {
    it('defaults to 280 px when nothing is persisted', () => {
      const svc = makeService();
      expect(svc.sidebarWidthPx()).toBe(LayoutSizesService.DEFAULT_SIDEBAR_PX);
      expect(svc.sidebarWidthPx()).toBe(280);
    });

    it('reads a valid persisted width back into the signal', () => {
      localStorage.setItem('devia:sidebar:widthPx', '320');
      const svc = makeService();
      expect(svc.sidebarWidthPx()).toBe(320);
    });

    it('clamps a persisted width that is below the MIN floor', () => {
      localStorage.setItem('devia:sidebar:widthPx', '12');
      const svc = makeService();
      expect(svc.sidebarWidthPx()).toBe(LayoutSizesService.MIN_SIDEBAR_PX);
    });

    it('falls back to default when the persisted width is garbage', () => {
      localStorage.setItem('devia:sidebar:widthPx', 'not-a-number');
      const svc = makeService();
      expect(svc.sidebarWidthPx()).toBe(LayoutSizesService.DEFAULT_SIDEBAR_PX);
    });

    it('reads the persisted collapsed flag', () => {
      localStorage.setItem('devia:sidebar:collapsed', '1');
      const svc = makeService();
      expect(svc.sidebarCollapsed()).toBe(true);
    });
  });

  describe('mainGridTemplate', () => {
    it('expands sidebar track to the persisted width', () => {
      localStorage.setItem('devia:sidebar:widthPx', '300');
      const svc = makeService();
      expect(svc.mainGridTemplate()).toBe('300px 6px minmax(0, 1fr) auto');
    });

    it('collapses sidebar track to the rail width when collapsed', () => {
      localStorage.setItem('devia:sidebar:collapsed', '1');
      const svc = makeService();
      expect(svc.mainGridTemplate()).toBe(
        `${LayoutSizesService.RAIL_PX}px 6px minmax(0, 1fr) auto`,
      );
    });
  });

  describe('toggleSidebarCollapse', () => {
    it('flips the collapsed flag and persists it', () => {
      const svc = makeService();
      expect(svc.sidebarCollapsed()).toBe(false);
      svc.toggleSidebarCollapse();
      expect(svc.sidebarCollapsed()).toBe(true);
      expect(localStorage.getItem('devia:sidebar:collapsed')).toBe('1');
      svc.toggleSidebarCollapse();
      expect(svc.sidebarCollapsed()).toBe(false);
      expect(localStorage.getItem('devia:sidebar:collapsed')).toBe('0');
    });
  });

  describe('resetSidebarWidth', () => {
    it('restores default width and persists', () => {
      localStorage.setItem('devia:sidebar:widthPx', '500');
      const svc = makeService();
      svc.resetSidebarWidth();
      expect(svc.sidebarWidthPx()).toBe(LayoutSizesService.DEFAULT_SIDEBAR_PX);
      expect(localStorage.getItem('devia:sidebar:widthPx')).toBe('280');
    });

    it('expands first if currently collapsed', () => {
      localStorage.setItem('devia:sidebar:collapsed', '1');
      const svc = makeService();
      svc.resetSidebarWidth();
      expect(svc.sidebarCollapsed()).toBe(false);
      expect(svc.sidebarWidthPx()).toBe(LayoutSizesService.DEFAULT_SIDEBAR_PX);
    });
  });

  describe('startSidebarDrag', () => {
    it('collapses to the rail when dragged below the usable minimum', () => {
      localStorage.setItem('devia:sidebar:widthPx', '280');
      const svc = makeService();
      svc.startSidebarDrag(new MouseEvent('mousedown', { button: 0, clientX: 280 }));
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 30 }));
      expect(svc.sidebarCollapsed()).toBe(true);
      // Pre-drag width is preserved so re-opening restores it.
      expect(svc.sidebarWidthPx()).toBe(280);
      document.dispatchEvent(new MouseEvent('mouseup'));
      expect(localStorage.getItem('devia:sidebar:collapsed')).toBe('1');
    });

    it('resizes without collapsing while above the minimum', () => {
      localStorage.setItem('devia:sidebar:widthPx', '280');
      const svc = makeService();
      svc.setViewportWidthForTesting(2000);
      svc.startSidebarDrag(new MouseEvent('mousedown', { button: 0, clientX: 280 }));
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 360 }));
      expect(svc.sidebarCollapsed()).toBe(false);
      expect(svc.sidebarWidthPx()).toBe(360);
      document.dispatchEvent(new MouseEvent('mouseup'));
    });

    it('expands from a collapsed rail when dragged right past the minimum', () => {
      localStorage.setItem('devia:sidebar:collapsed', '1');
      localStorage.setItem('devia:sidebar:widthPx', '280');
      const svc = makeService();
      svc.setViewportWidthForTesting(2000);
      svc.startSidebarDrag(new MouseEvent('mousedown', { button: 0, clientX: 0 }));
      // startWidth anchors at MIN (168); +120 → 288, above the minimum.
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 120 }));
      expect(svc.sidebarCollapsed()).toBe(false);
      expect(svc.sidebarWidthPx()).toBe(LayoutSizesService.MIN_SIDEBAR_PX + 120);
      document.dispatchEvent(new MouseEvent('mouseup'));
    });
  });

  describe('maxSidebarPx + viewport clamp', () => {
    it('caps the maximum at 50 % of the viewport', () => {
      const svc = makeService();
      svc.setViewportWidthForTesting(1000);
      expect(svc.maxSidebarPx()).toBe(500);
    });

    it('clamps the width down when the viewport shrinks under it', () => {
      localStorage.setItem('devia:sidebar:widthPx', '500');
      const svc = makeService();
      svc.setViewportWidthForTesting(800); // max = 400
      // The clamp effect runs synchronously inside the service injector.
      TestBed.tick();
      expect(svc.sidebarWidthPx()).toBeLessThanOrEqual(400);
    });
  });
});
