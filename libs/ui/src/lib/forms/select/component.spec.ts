import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeAll } from 'vitest';
import {
  SelectComponent,
  SelectOptionComponent,
  type SelectOption,
} from './component';

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
    <dv-select
      label="Status"
      placeholder="Choose status"
      [options]="options"
      (valueChange)="value = $event"
    />
  `,
  imports: [SelectComponent],
})
class SelectHostComponent {
  value = '';
  options: SelectOption[] = [
    { value: 'open', label: 'Open' },
    { value: 'closed', label: 'Closed' },
  ];
}

@Component({
  template: `
    <dv-select label="Priority" (valueChange)="value = $event">
      <dv-select-option value="high" label="High priority">
        <strong>High</strong>
        <span>priority</span>
      </dv-select-option>
    </dv-select>
  `,
  imports: [SelectComponent, SelectOptionComponent],
})
class ProjectedSelectHostComponent {
  value = '';
}

describe('SelectComponent', () => {
  let fixture: ComponentFixture<SelectComponent>;
  let component: SelectComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [SelectComponent],
    }).compileComponents();
    fixture = TestBed.createComponent(SelectComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('creates', () => expect(component).toBeTruthy());
  it('writes value via CVA', () => {
    component.writeValue('foo');
    expect((component as any).value()).toBe('foo');
  });
  it('disables via CVA', () => {
    component.setDisabledState(true);
    expect((component as any).isDisabled()).toBe(true);
  });

  it('does not render a native select control', () => {
    expect(fixture.nativeElement.querySelector('select')).toBeNull();
    expect(
      fixture.nativeElement.querySelector('[role="combobox"]'),
    ).toBeTruthy();
  });

  it('opens the custom listbox and emits selected option values', async () => {
    const hostFixture = TestBed.createComponent(SelectHostComponent);
    hostFixture.detectChanges();

    const trigger =
      hostFixture.nativeElement.querySelector<HTMLButtonElement>(
        '[role="combobox"]',
      );
    trigger?.click();
    hostFixture.detectChanges();
    await hostFixture.whenStable();

    const options =
      document.querySelectorAll<HTMLButtonElement>('.dv-select__option');
    expect(options.length).toBe(2);

    options[1].click();
    hostFixture.detectChanges();

    expect(hostFixture.componentInstance.value).toBe('closed');
    expect(trigger?.textContent).toContain('Closed');
  });

  it('uses the trigger width as the overlay minimum width', async () => {
    const hostFixture = TestBed.createComponent(SelectHostComponent);
    hostFixture.detectChanges();

    const trigger =
      hostFixture.nativeElement.querySelector<HTMLButtonElement>(
        '[role="combobox"]',
      );
    trigger?.click();
    hostFixture.detectChanges();
    await hostFixture.whenStable();

    const overlayPane =
      document.querySelector<HTMLElement>('.cdk-overlay-pane');
    const panel = document.querySelector<HTMLElement>('.dv-select__panel');

    expect(overlayPane?.style.minWidth).toBe(
      `${trigger?.getBoundingClientRect().width}px`,
    );
    expect(panel?.style.minWidth).toBe(
      `${trigger?.getBoundingClientRect().width}px`,
    );
    expect(overlayPane?.style.width).toBe('');
  });

  it('renders projected option content in the custom listbox', async () => {
    const hostFixture = TestBed.createComponent(ProjectedSelectHostComponent);
    hostFixture.detectChanges();

    const trigger =
      hostFixture.nativeElement.querySelector<HTMLButtonElement>(
        '[role="combobox"]',
      );
    trigger?.click();
    hostFixture.detectChanges();
    await hostFixture.whenStable();

    const option =
      document.querySelector<HTMLButtonElement>('.dv-select__option');
    expect(option?.textContent).toContain('High');
    expect(option?.textContent).toContain('priority');

    option?.click();
    hostFixture.detectChanges();

    expect(hostFixture.componentInstance.value).toBe('high');
    expect(trigger?.textContent).toContain('High');
  });
});
