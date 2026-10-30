import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ThemeToggleComponent } from './component';
import { DeviaThemeValue } from './models/theme-toggle.models';

describe('ThemeToggleComponent', () => {
  let fixture: ComponentFixture<ThemeToggleComponent>;
  let component: ThemeToggleComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ThemeToggleComponent],
    }).compileComponents();
    fixture = TestBed.createComponent(ThemeToggleComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('creates', () => expect(component).toBeTruthy());

  describe('light/dark button aria-label', () => {
    it('shows "Cambiar a modo oscuro" when theme is light', () => {
      fixture.componentRef.setInput('theme', 'light');
      fixture.detectChanges();
      const btn = fixture.nativeElement.querySelector(
        '[data-testid="theme-toggle-light-dark"]',
      ) as HTMLButtonElement;
      expect(btn.getAttribute('aria-label')).toBe('Cambiar a modo oscuro');
    });

    it('shows "Cambiar a modo claro" when theme is dark', () => {
      fixture.componentRef.setInput('theme', 'dark');
      fixture.detectChanges();
      const btn = fixture.nativeElement.querySelector(
        '[data-testid="theme-toggle-light-dark"]',
      ) as HTMLButtonElement;
      expect(btn.getAttribute('aria-label')).toBe('Cambiar a modo claro');
    });

    it('shows "Cambiar a modo claro" when theme is navy-dark', () => {
      fixture.componentRef.setInput('theme', 'navy-dark');
      fixture.detectChanges();
      const btn = fixture.nativeElement.querySelector(
        '[data-testid="theme-toggle-light-dark"]',
      ) as HTMLButtonElement;
      expect(btn.getAttribute('aria-label')).toBe('Cambiar a modo claro');
    });
  });

  describe('group button aria-label', () => {
    it('shows "Cambiar a tema Navy" when theme is light (violet group)', () => {
      fixture.componentRef.setInput('theme', 'light');
      fixture.detectChanges();
      const btn = fixture.nativeElement.querySelector(
        '[data-testid="theme-toggle-group"]',
      ) as HTMLButtonElement;
      expect(btn.getAttribute('aria-label')).toBe('Cambiar a tema Navy');
    });

    it('shows "Cambiar a tema Violet" when theme is navy', () => {
      fixture.componentRef.setInput('theme', 'navy');
      fixture.detectChanges();
      const btn = fixture.nativeElement.querySelector(
        '[data-testid="theme-toggle-group"]',
      ) as HTMLButtonElement;
      expect(btn.getAttribute('aria-label')).toBe('Cambiar a tema Violet');
    });
  });

  describe('changed output — toggle (light/dark)', () => {
    const cases: Array<[DeviaThemeValue, DeviaThemeValue]> = [
      ['light', 'dark'],
      ['dark', 'light'],
      ['navy', 'navy-dark'],
      ['navy-dark', 'navy'],
    ];

    for (const [from, to] of cases) {
      it(`emits "${to}" when toggle clicked from "${from}"`, () => {
        fixture.componentRef.setInput('theme', from);
        fixture.detectChanges();
        const emitted: DeviaThemeValue[] = [];
        component.changed.subscribe((v) => emitted.push(v));
        const btn = fixture.nativeElement.querySelector(
          '[data-testid="theme-toggle-light-dark"]',
        ) as HTMLButtonElement;
        btn.click();
        expect(emitted).toEqual([to]);
      });
    }
  });

  describe('changed output — switchGroup', () => {
    const cases: Array<[DeviaThemeValue, DeviaThemeValue]> = [
      ['light', 'navy'],
      ['dark', 'navy-dark'],
      ['navy', 'light'],
      ['navy-dark', 'dark'],
    ];

    for (const [from, to] of cases) {
      it(`emits "${to}" when group clicked from "${from}"`, () => {
        fixture.componentRef.setInput('theme', from);
        fixture.detectChanges();
        const emitted: DeviaThemeValue[] = [];
        component.changed.subscribe((v) => emitted.push(v));
        const btn = fixture.nativeElement.querySelector(
          '[data-testid="theme-toggle-group"]',
        ) as HTMLButtonElement;
        btn.click();
        expect(emitted).toEqual([to]);
      });
    }
  });

  it('uses custom lightDarkLabel when provided', () => {
    fixture.componentRef.setInput('theme', 'light');
    fixture.componentRef.setInput('lightDarkLabel', 'Toggle theme');
    fixture.detectChanges();
    const btn = fixture.nativeElement.querySelector(
      '[data-testid="theme-toggle-light-dark"]',
    ) as HTMLButtonElement;
    expect(btn.getAttribute('aria-label')).toBe('Toggle theme');
  });

  it('uses custom groupLabel when provided', () => {
    fixture.componentRef.setInput('theme', 'light');
    fixture.componentRef.setInput('groupLabel', 'Switch group');
    fixture.detectChanges();
    const btn = fixture.nativeElement.querySelector(
      '[data-testid="theme-toggle-group"]',
    ) as HTMLButtonElement;
    expect(btn.getAttribute('aria-label')).toBe('Switch group');
  });
});
