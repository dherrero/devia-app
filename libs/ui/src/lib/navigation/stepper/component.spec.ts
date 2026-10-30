import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  StepperComponent,
  StepperContentDirective,
  type StepperStep,
} from './component';

const STEPS: StepperStep[] = [
  { id: 'a', label: 'Uno', state: 'done', notes: ['Confirmado: x'] },
  { id: 'b', label: 'Dos', state: 'active' },
  { id: 'c', label: 'Tres', state: 'pending' },
];

@Component({
  imports: [StepperComponent, StepperContentDirective],
  template: `
    <dv-stepper
      [steps]="steps()"
      [(collapsed)]="collapsed"
      progressLabel="Paso 2/3"
      expandLabel="Ver"
      collapseLabel="Ocultar"
      ariaLabel="Progreso"
    >
      <ng-template dvStepContent let-step>
        <span class="probe">form:{{ step.id }}</span>
      </ng-template>
    </dv-stepper>
  `,
})
class HostComponent {
  readonly steps = signal<StepperStep[]>(STEPS);
  readonly collapsed = signal(true);
}

function mount() {
  const fixture = TestBed.createComponent(HostComponent);
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  return { fixture, el, host: fixture.componentInstance };
}

describe('StepperComponent', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [HostComponent],
    }).compileComponents();
  });

  it('collapsed: one line with the progress label and the active step, no list', () => {
    const { el } = mount();

    expect(el.textContent).toContain('Paso 2/3');
    expect(el.querySelector('.dv-stepper__current')?.textContent).toContain(
      'Dos',
    );
    expect(el.querySelector('.dv-stepper__list')).toBeNull();
    expect(
      el.querySelector('.dv-stepper__toggle')?.getAttribute('aria-expanded'),
    ).toBe('false');
  });

  it('progress bar reflects the done share', () => {
    const { el } = mount();
    expect(el.querySelector('dv-progress')?.getAttribute('aria-valuenow')).toBe(
      '33',
    );
  });

  it('expanding lists every step and marks the active one as current', () => {
    const { el, fixture } = mount();
    (el.querySelector('.dv-stepper__toggle') as HTMLButtonElement).click();
    fixture.detectChanges();

    const items = [...el.querySelectorAll('.dv-stepper__step')];
    expect(items).toHaveLength(3);
    expect(items[1]?.getAttribute('aria-current')).toBe('step');
    expect(items[0]?.getAttribute('aria-current')).toBeNull();
    expect(items[0]?.textContent).toContain('Confirmado: x');
  });

  it('renders the projected content inside the active step only', () => {
    const { el, fixture, host } = mount();
    host.collapsed.set(false);
    fixture.detectChanges();

    const probes = el.querySelectorAll('.probe');
    expect(probes).toHaveLength(1);
    expect(probes[0]?.textContent).toBe('form:b');
    expect(probes[0]?.closest('.dv-stepper__step--active')).not.toBeNull();
  });

  it('follows the data: the content moves when the next step becomes active', () => {
    const { el, fixture, host } = mount();
    host.collapsed.set(false);
    host.steps.set([
      { id: 'a', label: 'Uno', state: 'done' },
      { id: 'b', label: 'Dos', state: 'done' },
      { id: 'c', label: 'Tres', state: 'active' },
    ]);
    fixture.detectChanges();

    expect(el.querySelector('.probe')?.textContent).toBe('form:c');
  });

  it('with no active step, the first pending one is current', () => {
    const { el, fixture, host } = mount();
    host.collapsed.set(false);
    host.steps.set([
      { id: 'a', label: 'Uno', state: 'done' },
      { id: 'b', label: 'Dos', state: 'pending' },
    ]);
    fixture.detectChanges();

    const items = [...el.querySelectorAll('.dv-stepper__step')];
    expect(items[1]?.getAttribute('aria-current')).toBe('step');
  });

  it('the toggle writes back through the two-way binding', () => {
    const { el, fixture, host } = mount();
    (el.querySelector('.dv-stepper__toggle') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(host.collapsed()).toBe(false);
  });
});
