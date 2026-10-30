import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { LucideX } from '@lucide/angular';
import { IconComponent } from '../../atoms/icon';
import { ButtonComponent } from './component';

@Component({
  imports: [ButtonComponent, IconComponent],
  template: `
    <dv-button iconOnly ariaLabel="Cerrar">
      texto descartado
      <dv-icon [icon]="icon" size="sm" />
    </dv-button>
  `,
})
class IconOnlyButtonHostComponent {
  readonly icon = LucideX;
}

@Component({
  imports: [ButtonComponent, IconComponent],
  template: `
    <dv-button>
      <dv-icon [icon]="icon" size="sm" />
      Texto visible
    </dv-button>
  `,
})
class IconTextButtonHostComponent {
  readonly icon = LucideX;
}

describe('ButtonComponent', () => {
  let fixture: ComponentFixture<ButtonComponent>;
  let component: ButtonComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [
        ButtonComponent,
        IconOnlyButtonHostComponent,
        IconTextButtonHostComponent,
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(ButtonComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('should emit clicked on button click', () => {
    const spy = vi.fn();
    component.clicked.subscribe(spy);
    const btn = fixture.nativeElement.querySelector(
      '[data-testid="dv-button"]',
    );
    btn.click();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('should not emit clicked when disabled', () => {
    const spy = vi.fn();
    component.clicked.subscribe(spy);
    fixture.componentRef.setInput('disabled', true);
    fixture.detectChanges();
    const btn = fixture.nativeElement.querySelector(
      '[data-testid="dv-button"]',
    );
    btn.click();
    expect(spy).not.toHaveBeenCalled();
  });

  it('should not emit clicked when loading', () => {
    const spy = vi.fn();
    component.clicked.subscribe(spy);
    fixture.componentRef.setInput('loading', true);
    fixture.detectChanges();
    const btn = fixture.nativeElement.querySelector(
      '[data-testid="dv-button"]',
    );
    btn.click();
    expect(spy).not.toHaveBeenCalled();
  });

  it('should show spinner when loading', () => {
    fixture.componentRef.setInput('loading', true);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('dv-spinner')).toBeTruthy();
  });

  it('should apply variant class', () => {
    fixture.componentRef.setInput('variant', 'danger');
    fixture.detectChanges();
    const btn = fixture.nativeElement.querySelector('.dv-button');
    expect(btn.className).toContain('dv-button--danger');
  });

  it('projects only dv-icon content when iconOnly is enabled', async () => {
    const hostFixture = TestBed.createComponent(IconOnlyButtonHostComponent);
    hostFixture.detectChanges();

    const button = hostFixture.nativeElement.querySelector(
      '[data-testid="dv-button"]',
    ) as HTMLButtonElement;

    expect(button.querySelector('dv-icon')).toBeTruthy();
    expect(button.textContent).not.toContain('texto descartado');
  });

  it('projects dv-icon and text content when iconOnly is disabled', async () => {
    const hostFixture = TestBed.createComponent(IconTextButtonHostComponent);
    hostFixture.detectChanges();

    const button = hostFixture.nativeElement.querySelector(
      '[data-testid="dv-button"]',
    ) as HTMLButtonElement;

    expect(button.querySelector('dv-icon')).toBeTruthy();
    expect(button.textContent).toContain('Texto visible');
  });
});
