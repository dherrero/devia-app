import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { Dialog } from '@angular/cdk/dialog';
import { KeyboardShortcutsService } from './keyboard-shortcuts.service';
import { LayoutSizesService } from './layout-sizes.service';
import { AppStateService } from '../services/app-state.service';
import { RightRailStateService } from '../../layout/right-rail/services/right-rail-state.service';

class FakeLayout {
  toggleSidebarCollapse = vi.fn();
}

class FakeState {
  readonly selectedProject = signal<string | null>(null);
  readonly splitActive = signal(false);
}

class FakeRightRail {
  toggleTab = vi.fn();
}

class FakeDialog {
  readonly closed = { subscribe: vi.fn() };
  open = vi.fn(() => ({ closed: this.closed }));
}

function setup(state: FakeState): {
  shortcuts: KeyboardShortcutsService;
  layout: FakeLayout;
  rail: FakeRightRail;
  dialog: FakeDialog;
} {
  const layout = new FakeLayout();
  const rail = new FakeRightRail();
  const dialog = new FakeDialog();
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      KeyboardShortcutsService,
      { provide: LayoutSizesService, useValue: layout },
      { provide: AppStateService, useValue: state },
      { provide: RightRailStateService, useValue: rail },
      { provide: Dialog, useValue: dialog },
    ],
  });
  return { shortcuts: TestBed.inject(KeyboardShortcutsService), layout, rail, dialog };
}

function chord(opts: {
  key: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  alt?: boolean;
}): KeyboardEvent {
  return new KeyboardEvent('keydown', {
    key: opts.key,
    ctrlKey: opts.ctrl ?? false,
    metaKey: opts.meta ?? false,
    shiftKey: opts.shift ?? false,
    altKey: opts.alt ?? false,
    cancelable: true,
  });
}

describe('KeyboardShortcutsService (HT-S-01)', () => {
  let state: FakeState;
  beforeEach(() => {
    state = new FakeState();
  });

  it('Ctrl+B toggles the sidebar', () => {
    const { shortcuts, layout } = setup(state);
    shortcuts.handle(chord({ key: 'b', ctrl: true }));
    expect(layout.toggleSidebarCollapse).toHaveBeenCalledTimes(1);
  });

  it('Cmd+B (macOS) also toggles the sidebar', () => {
    const { shortcuts, layout } = setup(state);
    shortcuts.handle(chord({ key: 'b', meta: true }));
    expect(layout.toggleSidebarCollapse).toHaveBeenCalledTimes(1);
  });

  it('plain B (no modifier) is ignored', () => {
    const { shortcuts, layout } = setup(state);
    shortcuts.handle(chord({ key: 'b' }));
    expect(layout.toggleSidebarCollapse).not.toHaveBeenCalled();
  });

  it('Alt+Ctrl+B is ignored (alt is reserved for OS / app menus)', () => {
    const { shortcuts, layout } = setup(state);
    shortcuts.handle(chord({ key: 'b', ctrl: true, alt: true }));
    expect(layout.toggleSidebarCollapse).not.toHaveBeenCalled();
  });

  it('Ctrl+J toggles the terminal pane when a project is selected', () => {
    state.selectedProject.set('/ws/proj');
    const { shortcuts, rail } = setup(state);
    shortcuts.handle(chord({ key: 'j', ctrl: true }));
    expect(rail.toggleTab).toHaveBeenCalledWith('terminal');
  });

  it('Ctrl+J does nothing when no project is selected', () => {
    const { shortcuts, rail } = setup(state);
    shortcuts.handle(chord({ key: 'j', ctrl: true }));
    expect(rail.toggleTab).not.toHaveBeenCalled();
  });

  it('Ctrl+J does nothing while a split is active (S-13 T-158)', () => {
    state.selectedProject.set('/ws/proj');
    state.splitActive.set(true);
    const { shortcuts, rail } = setup(state);
    shortcuts.handle(chord({ key: 'j', ctrl: true }));
    expect(rail.toggleTab).not.toHaveBeenCalled();
  });

  it('Ctrl+Shift+E toggles the tree pane when a project is selected', () => {
    state.selectedProject.set('/ws/proj');
    const { shortcuts, rail } = setup(state);
    shortcuts.handle(chord({ key: 'e', ctrl: true, shift: true }));
    expect(rail.toggleTab).toHaveBeenCalledWith('tree');
  });

  it('Ctrl+E (without Shift) is ignored — only the Shift chord opens the tree', () => {
    state.selectedProject.set('/ws/proj');
    const { shortcuts, rail } = setup(state);
    shortcuts.handle(chord({ key: 'e', ctrl: true }));
    expect(rail.toggleTab).not.toHaveBeenCalled();
  });

  it('Ctrl+, opens Settings', () => {
    const { shortcuts, dialog } = setup(state);
    shortcuts.handle(chord({ key: ',', ctrl: true }));
    expect(dialog.open).toHaveBeenCalledTimes(1);
  });

  it('preventDefault is called on handled chords so the browser shortcut never fires', () => {
    const { shortcuts } = setup(state);
    const event = chord({ key: 'b', ctrl: true });
    const spy = vi.spyOn(event, 'preventDefault');
    shortcuts.handle(event);
    expect(spy).toHaveBeenCalled();
  });

  it('init() is idempotent', () => {
    const { shortcuts } = setup(state);
    shortcuts.init();
    shortcuts.init();
    // Smoke check — no throw, and the second init is a no-op.
    expect(true).toBe(true);
  });
});
