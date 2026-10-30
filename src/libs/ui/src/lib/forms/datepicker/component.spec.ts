import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { FormsModule } from '@angular/forms';
import { beforeAll } from 'vitest';
import { DatepickerComponent } from './component';

beforeAll(() => {
  class TestMutationObserver {
    observe(): void {}
    disconnect(): void {}
    takeRecords(): MutationRecord[] {
      return [];
    }
  }

  globalThis.MutationObserver = TestMutationObserver as typeof MutationObserver;
});

@Component({
  template: `
    <dv-datepicker
      label="Due date"
      placeholder="Select date"
      [(ngModel)]="value"
      (valueChange)="changed = $event"
    />
  `,
  imports: [DatepickerComponent, FormsModule],
})
class DatepickerHostComponent {
  value = '';
  changed = '';
}

describe('DatepickerComponent', () => {
  let fixture: ComponentFixture<DatepickerComponent>;
  let component: DatepickerComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [DatepickerComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(DatepickerComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('creates', () => {
    expect(component).toBeTruthy();
  });

  it('writes an ISO date via CVA', () => {
    component.writeValue('2026-05-18');
    fixture.detectChanges();

    const input = fixture.nativeElement.querySelector<HTMLInputElement>(
      '[data-testid="dv-datepicker-input"]',
    );

    expect(input?.value).toContain('2026');
  });

  it('ignores invalid CVA values', () => {
    component.writeValue('not-a-date');
    fixture.detectChanges();

    const input = fixture.nativeElement.querySelector<HTMLInputElement>(
      '[data-testid="dv-datepicker-input"]',
    );

    expect(input?.value).toBe('');
  });

  it('opens the custom calendar and emits selected dates', async () => {
    const hostFixture = TestBed.createComponent(DatepickerHostComponent);
    hostFixture.detectChanges();

    const input = hostFixture.nativeElement.querySelector<HTMLInputElement>(
      '[data-testid="dv-datepicker-input"]',
    );
    input?.click();
    hostFixture.detectChanges();
    await hostFixture.whenStable();

    const days = document.querySelectorAll<HTMLButtonElement>(
      '.dv-datepicker__day:not([disabled])',
    );
    expect(days.length).toBeGreaterThan(0);

    days[0].click();
    hostFixture.detectChanges();

    expect(hostFixture.componentInstance.value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(hostFixture.componentInstance.changed).toBe(
      hostFixture.componentInstance.value,
    );
  });

  it('uses the trigger width as the overlay minimum width', async () => {
    const hostFixture = TestBed.createComponent(DatepickerHostComponent);
    hostFixture.detectChanges();

    const input = hostFixture.nativeElement.querySelector<HTMLInputElement>(
      '[data-testid="dv-datepicker-input"]',
    );
    input?.click();
    hostFixture.detectChanges();
    await hostFixture.whenStable();

    const overlayPane =
      document.querySelector<HTMLElement>('.cdk-overlay-pane');
    const panel = document.querySelector<HTMLElement>('.dv-datepicker__panel');

    expect(overlayPane?.style.minWidth).toBe(
      `${input?.getBoundingClientRect().width}px`,
    );
    expect(panel?.style.minWidth).toBe(
      `${input?.getBoundingClientRect().width}px`,
    );
  });
});
