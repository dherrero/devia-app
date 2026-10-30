import { describe, it, expect, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { SidebarLayoutService } from './sidebar-layout.service';

function makeService(): SidebarLayoutService {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [SidebarLayoutService] });
  return TestBed.inject(SidebarLayoutService);
}

describe('SidebarLayoutService (HT-SB-01)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  describe('hydration', () => {
    it('defaults pinnedHeightPx to null (use 1fr/1fr split)', () => {
      const svc = makeService();
      expect(svc.pinnedHeightPx()).toBeNull();
    });

    it('hydrates pinnedHeightPx from persisted value', () => {
      localStorage.setItem('devia:sidebar:pinnedHeightPx', '180');
      const svc = makeService();
      expect(svc.pinnedHeightPx()).toBe(180);
    });

    it('ignores garbage persisted pinned height', () => {
      localStorage.setItem('devia:sidebar:pinnedHeightPx', 'NaN');
      const svc = makeService();
      expect(svc.pinnedHeightPx()).toBeNull();
    });

    it('defaults sessionsHeightPx to the historical 240px', () => {
      const svc = makeService();
      expect(svc.sessionsHeightPx()).toBe(SidebarLayoutService.DEFAULT_SESSIONS_PX);
    });

    it('hydrates sessionsCollapsed from persisted "1"', () => {
      localStorage.setItem('devia:sidebar:sessionsCollapsed', '1');
      const svc = makeService();
      expect(svc.sessionsCollapsed()).toBe(true);
    });
  });

  describe('flex computeds', () => {
    it('pinnedFlex emits 1 1 0 when free-flex', () => {
      const svc = makeService();
      expect(svc.pinnedFlex()).toBe('1 1 0');
    });

    it('pinnedFlex pins a px height once dragged', () => {
      localStorage.setItem('devia:sidebar:pinnedHeightPx', '200');
      const svc = makeService();
      expect(svc.pinnedFlex()).toBe('0 0 200px');
    });

    it('sessionsFlex collapses to "0 0 auto" when collapsed', () => {
      localStorage.setItem('devia:sidebar:sessionsCollapsed', '1');
      const svc = makeService();
      expect(svc.sessionsFlex()).toBe('0 0 auto');
    });

    it('sessionsFlex pins the persisted height when expanded', () => {
      const svc = makeService();
      expect(svc.sessionsFlex()).toBe('0 0 240px');
    });
  });

  describe('toggleSessionsCollapsed', () => {
    it('flips the flag and persists it', () => {
      const svc = makeService();
      expect(svc.sessionsCollapsed()).toBe(false);
      svc.toggleSessionsCollapsed();
      expect(svc.sessionsCollapsed()).toBe(true);
      expect(localStorage.getItem('devia:sidebar:sessionsCollapsed')).toBe('1');
      svc.toggleSessionsCollapsed();
      expect(svc.sessionsCollapsed()).toBe(false);
      expect(localStorage.getItem('devia:sidebar:sessionsCollapsed')).toBe('0');
    });
  });

  describe('reset splitters', () => {
    it('resetPinnedSplitter clears pinned height + storage', () => {
      localStorage.setItem('devia:sidebar:pinnedHeightPx', '180');
      const svc = makeService();
      svc.resetPinnedSplitter();
      expect(svc.pinnedHeightPx()).toBeNull();
      expect(localStorage.getItem('devia:sidebar:pinnedHeightPx')).toBeNull();
    });

    it('resetSessionsSplitter restores default + clears storage', () => {
      localStorage.setItem('devia:sidebar:sessionsHeightPx', '420');
      const svc = makeService();
      svc.resetSessionsSplitter();
      expect(svc.sessionsHeightPx()).toBe(SidebarLayoutService.DEFAULT_SESSIONS_PX);
      expect(localStorage.getItem('devia:sidebar:sessionsHeightPx')).toBeNull();
    });
  });

  describe('startPinnedDrag clamp logic', () => {
    function fakeEvent(clientY: number): MouseEvent {
      return new MouseEvent('mousedown', { button: 0, clientY, cancelable: true });
    }

    it('persists and clamps to the available room', () => {
      const svc = makeService();
      svc.startPinnedDrag(fakeEvent(0), {
        anchorHeightPx: 100,
        combinedHeightPx: 400,
      });
      // Drag down by 500 px → would set 600, but max = 400 - MIN = 344.
      document.dispatchEvent(new MouseEvent('mousemove', { clientY: 500 }));
      document.dispatchEvent(new MouseEvent('mouseup', { clientY: 500 }));
      expect(svc.pinnedHeightPx()).toBeLessThanOrEqual(
        400 - SidebarLayoutService.MIN_SECTION_PX,
      );
      expect(localStorage.getItem('devia:sidebar:pinnedHeightPx')).not.toBeNull();
    });

    it('floors at MIN_SECTION_PX (drag up beyond the panel top)', () => {
      const svc = makeService();
      svc.startPinnedDrag(fakeEvent(0), {
        anchorHeightPx: 100,
        combinedHeightPx: 400,
      });
      document.dispatchEvent(new MouseEvent('mousemove', { clientY: -1000 }));
      document.dispatchEvent(new MouseEvent('mouseup', { clientY: -1000 }));
      expect(svc.pinnedHeightPx()).toBe(SidebarLayoutService.MIN_SECTION_PX);
    });

    it('ignores non-primary mouse buttons', () => {
      const svc = makeService();
      const event = new MouseEvent('mousedown', { button: 2, clientY: 0, cancelable: true });
      svc.startPinnedDrag(event, { anchorHeightPx: 100, combinedHeightPx: 400 });
      // No movement listener should be attached — verifying by sending a
      // bogus mousemove that ought to be ignored.
      document.dispatchEvent(new MouseEvent('mousemove', { clientY: 500 }));
      expect(svc.pinnedHeightPx()).toBeNull();
    });
  });

  describe('startSessionsDrag (inverse axis)', () => {
    function fakeEvent(clientY: number): MouseEvent {
      return new MouseEvent('mousedown', { button: 0, clientY, cancelable: true });
    }

    it('dragging DOWN shrinks the Sesiones panel (inverse delta)', () => {
      const svc = makeService();
      svc.startSessionsDrag(fakeEvent(0), {
        anchorHeightPx: 240,
        combinedHeightPx: 500,
      });
      // delta = +50 → next = 240 - 50 = 190
      document.dispatchEvent(new MouseEvent('mousemove', { clientY: 50 }));
      document.dispatchEvent(new MouseEvent('mouseup', { clientY: 50 }));
      expect(svc.sessionsHeightPx()).toBe(190);
    });
  });
});
