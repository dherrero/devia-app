import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TestBed, ComponentFixture } from '@angular/core/testing';
import { TranslateModule } from '@ngx-translate/core';
import { computed, signal } from '@angular/core';
import { TitlebarComponent } from './titlebar.component';
import { ElectronApiService } from '../../core/services/electron-api.service';
import { ThemeService } from '../../core/theme/theme.service';
import type { ThemeFamily, ThemeMode } from '../../core/theme/models/theme-option.model';
import { RendererZoomService } from '../../core/zoom/renderer-zoom.service';

class FakeTheme {
  readonly family = signal<ThemeFamily>('violet');
  readonly mode = signal<ThemeMode>('light');
  readonly setTheme = vi.fn((family: ThemeFamily, mode: ThemeMode) => {
    this.family.set(family);
    this.mode.set(mode);
  });
}

class FakeZoom {
  private readonly _percent = signal(100);
  readonly percent = this._percent.asReadonly();
  readonly label = computed(() => `${this._percent()}%`);
  readonly canDecrease = computed(() => this._percent() > 80);
  readonly canIncrease = computed(() => this._percent() < 140);
  readonly decrease = vi.fn(() => this._percent.set(this._percent() - 10));
  readonly increase = vi.fn(() => this._percent.set(this._percent() + 10));
  readonly reset = vi.fn(() => this._percent.set(100));
}

describe('TitlebarComponent (HT-TB-01)', () => {
  let fixture: ComponentFixture<TitlebarComponent>;
  let theme: FakeTheme;
  let zoom: FakeZoom;
  let api: Pick<ElectronApiService, 'platform' | 'minimizeWindow' | 'toggleMaximizeWindow' | 'closeWindow'>;

  beforeEach(async () => {
    theme = new FakeTheme();
    zoom = new FakeZoom();
    api = {
      platform: 'linux',
      minimizeWindow: vi.fn().mockResolvedValue(true),
      toggleMaximizeWindow: vi.fn().mockResolvedValue(true),
      closeWindow: vi.fn().mockResolvedValue(true),
    };
    await TestBed.configureTestingModule({
      imports: [TitlebarComponent, TranslateModule.forRoot()],
      providers: [
        { provide: ThemeService, useValue: theme },
        { provide: RendererZoomService, useValue: zoom },
        { provide: ElectronApiService, useValue: api },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(TitlebarComponent);
    fixture.detectChanges();
  });

  afterEach(() => {
    vi.useRealTimers();
    fixture.destroy();
  });

  it('mounts the shared two-button theme switcher', () => {
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('.titlebar-actions dv-theme-toggle')).not.toBeNull();
    expect(host.querySelector('.titlebar-actions dv-menu')).not.toBeNull();
    expect(host.querySelector('dv-theme-toggle')).not.toBeNull();
    expect(host.querySelectorAll('.dv-theme-toggle__btn')).toHaveLength(2);
  });

  it('maps the desktop theme state to the shared toggle value', () => {
    theme.family.set('navy');
    theme.mode.set('dark');
    fixture.detectChanges();
    const buttons = (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>(
      '.dv-theme-toggle__btn',
    );

    expect(buttons[0]?.getAttribute('aria-label')).toBe('Cambiar a modo claro');
    expect(buttons[1]?.getAttribute('aria-label')).toBe('Cambiar a tema Violet');
  });

  it('maps shared toggle values back to ThemeService.setTheme', () => {
    fixture.componentInstance.onThemeChanged('navy-dark');
    expect(theme.setTheme).toHaveBeenCalledWith('navy', 'dark');
    fixture.componentInstance.onThemeChanged('light');
    expect(theme.setTheme).toHaveBeenCalledWith('violet', 'light');
  });

  it('exposes kebab actions and the separated zoom control row', () => {
    const items = fixture.componentInstance.menuItems;
    expect(items.map((i) => i.id)).toEqual(['status', 'stop-all', 'zoom', 'templates', 'settings']);
    const zoomItem = items.find((item) => item.id === 'zoom');
    expect(zoomItem?.kind).toBe('zoom-control');
    if (zoomItem?.kind === 'zoom-control') {
      expect(zoomItem.valueLabel).toBe('100%');
      expect(zoomItem.dividerBefore).toBe(true);
      expect(zoomItem.decreaseAction.id).toBe('zoom-out');
      expect(zoomItem.resetAction.id).toBe('zoom-reset');
      expect(zoomItem.increaseAction.id).toBe('zoom-in');
    }
    for (const item of items.filter((i) => i.kind !== 'zoom-control')) {
      // HT-TB-01: no `matIcon` strings — only `icon` (LucideIcon component).
      expect(item.matIcon).toBeUndefined();
      expect(item.icon).toBeDefined();
    }
  });

  it('dispatches the right output per kebab action', () => {
    const events: string[] = [];
    fixture.componentInstance.status.subscribe(() => events.push('status'));
    fixture.componentInstance.stopAll.subscribe(() => events.push('stopAll'));
    fixture.componentInstance.editBases.subscribe(() => events.push('editBases'));
    fixture.componentInstance.settings.subscribe(() => events.push('settings'));
    for (const item of fixture.componentInstance.menuItems) {
      fixture.componentInstance.onMenuItem(item);
    }
    expect(events).toEqual(['status', 'stopAll', 'editBases', 'settings']);
  });

  it('routes zoom menu controls through RendererZoomService', () => {
    fixture.componentInstance.onMenuItem({ id: 'zoom-out', label: 'Zoom out', closeOnActivate: false });
    fixture.componentInstance.onMenuItem({ id: 'zoom-reset', label: 'Reset zoom', closeOnActivate: false });
    fixture.componentInstance.onMenuItem({ id: 'zoom-in', label: 'Zoom in', closeOnActivate: false });

    expect(zoom.decrease).toHaveBeenCalledOnce();
    expect(zoom.reset).toHaveBeenCalledOnce();
    expect(zoom.increase).toHaveBeenCalledOnce();
  });

  it('does not show a tooltip over the kebab menu trigger', () => {
    vi.useFakeTimers();
    const host = fixture.nativeElement as HTMLElement;
    host.querySelector('.titlebar-actions button[dsMenuTriggerButton]')?.dispatchEvent(new MouseEvent('mouseenter'));
    vi.advanceTimersByTime(350);
    fixture.detectChanges();

    expect(document.querySelector('.dv-tooltip-panel')).toBeNull();
  });

  it('renders macOS-style custom window controls on the right', () => {
    const host = fixture.nativeElement as HTMLElement;
    const controls = host.querySelectorAll<HTMLButtonElement>('.window-controls dv-button button');

    expect(controls).toHaveLength(3);
    expect(controls[0]?.getAttribute('aria-label')).toBe('Close window');
    expect(controls[1]?.getAttribute('aria-label')).toBe('Minimize window');
    expect(controls[2]?.getAttribute('aria-label')).toBe('Maximize or restore window');
  });

  it('routes custom window controls through ElectronApiService', () => {
    const host = fixture.nativeElement as HTMLElement;
    const [close, minimize, maximize] = Array.from(
      host.querySelectorAll<HTMLButtonElement>('.window-controls dv-button button'),
    );

    close?.click();
    minimize?.click();
    maximize?.click();

    expect(api.closeWindow).toHaveBeenCalledOnce();
    expect(api.minimizeWindow).toHaveBeenCalledOnce();
    expect(api.toggleMaximizeWindow).toHaveBeenCalledOnce();
  });

  it('uses Windows order when the controls are on Windows: minimize, maximize, close', async () => {
    TestBed.resetTestingModule();
    theme = new FakeTheme();
    api = {
      platform: 'win32',
      minimizeWindow: vi.fn().mockResolvedValue(true),
      toggleMaximizeWindow: vi.fn().mockResolvedValue(true),
      closeWindow: vi.fn().mockResolvedValue(true),
    };
    await TestBed.configureTestingModule({
      imports: [TitlebarComponent, TranslateModule.forRoot()],
      providers: [
        { provide: ThemeService, useValue: theme },
        { provide: RendererZoomService, useValue: new FakeZoom() },
        { provide: ElectronApiService, useValue: api },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(TitlebarComponent);
    fixture.detectChanges();

    const controls = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>(
        '.window-controls dv-button button',
      ),
    );

    expect(controls.map((control) => control.getAttribute('aria-label'))).toEqual([
      'Minimize window',
      'Maximize or restore window',
      'Close window',
    ]);
  });

  it('renders NO custom window controls on macOS (native traffic lights are used)', async () => {
    TestBed.resetTestingModule();
    theme = new FakeTheme();
    api = {
      platform: 'darwin',
      minimizeWindow: vi.fn().mockResolvedValue(true),
      toggleMaximizeWindow: vi.fn().mockResolvedValue(true),
      closeWindow: vi.fn().mockResolvedValue(true),
    };
    await TestBed.configureTestingModule({
      imports: [TitlebarComponent, TranslateModule.forRoot()],
      providers: [
        { provide: ThemeService, useValue: theme },
        { provide: RendererZoomService, useValue: new FakeZoom() },
        { provide: ElectronApiService, useValue: api },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(TitlebarComponent);
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).querySelector('.window-controls')).toBeNull();
  });
});
