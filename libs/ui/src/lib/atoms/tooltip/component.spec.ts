import { Component } from '@angular/core';
import {
  ComponentFixture,
  TestBed,
  fakeAsync,
  tick,
} from '@angular/core/testing';
import { OverlayContainer, OverlayModule } from '@angular/cdk/overlay';
import { afterEach } from 'vitest';
import { TooltipDirective } from './component';

@Component({
  imports: [TooltipDirective],
  template: `
    <button [dvTooltip]="'Hello'" data-testid="trigger">Hover me</button>
    <button [dvTooltip]="''" data-testid="empty-trigger">No tooltip</button>
  `,
})
class TestHostComponent {}

describe('TooltipDirective', () => {
  let fixture: ComponentFixture<TestHostComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [TestHostComponent, OverlayModule],
    }).compileComponents();

    fixture = TestBed.createComponent(TestHostComponent);
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
    TestBed.inject(OverlayContainer).ngOnDestroy();
  });

  it('should create', () => {
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('should open tooltip on mouseenter', fakeAsync(() => {
    const trigger = fixture.nativeElement.querySelector(
      '[data-testid="trigger"]',
    );
    trigger.dispatchEvent(new MouseEvent('mouseenter'));
    tick(300);
    fixture.detectChanges();

    const pane = document.querySelector<HTMLElement>('.dv-tooltip-panel');
    expect(pane).not.toBeNull();
    expect(pane?.textContent).toContain('Hello');
  }));

  it('does not let the tooltip overlay intercept pointer events', fakeAsync(() => {
    const trigger = fixture.nativeElement.querySelector(
      '[data-testid="trigger"]',
    );
    trigger.dispatchEvent(new MouseEvent('mouseenter'));
    tick(300);
    fixture.detectChanges();

    const host = document.querySelector<HTMLElement>(
      '.cdk-overlay-connected-position-bounding-box',
    );
    expect(host?.style.pointerEvents).toBe('none');
  }));

  it('does not open for empty tooltip text', fakeAsync(() => {
    const trigger = fixture.nativeElement.querySelector(
      '[data-testid="empty-trigger"]',
    );
    trigger.dispatchEvent(new MouseEvent('mouseenter'));
    tick(300);
    fixture.detectChanges();

    expect(document.querySelector('.dv-tooltip-panel')).toBeNull();
  }));
});
