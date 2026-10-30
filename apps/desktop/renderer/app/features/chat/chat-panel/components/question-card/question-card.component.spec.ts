/**
 * UC-FIX-019 — Real Angular TestBed tests for QuestionCardComponent.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { TestBed, ComponentFixture } from '@angular/core/testing';
import { TranslateModule } from '@ngx-translate/core';
import { QuestionCardComponent } from './question-card.component';
import type { QuestionAskEvent } from '../../../../../../types/devia';

function makeQuestion(overrides: Partial<QuestionAskEvent> = {}): QuestionAskEvent {
  return {
    project: '/ws/proj',
    toolUseId: 'qu-1',
    question: 'Should I overwrite the file?',
    ...overrides,
  };
}

describe('QuestionCardComponent', () => {
  let fixture: ComponentFixture<QuestionCardComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [QuestionCardComponent, TranslateModule.forRoot()],
    }).compileComponents();
    fixture = TestBed.createComponent(QuestionCardComponent);
  });

  it('AC1: renders the question text when question is set', () => {
    fixture.componentRef.setInput('question', makeQuestion({ question: 'Overwrite?' }));
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.q-text')?.textContent?.trim()).toBe('Overwrite?');
  });

  it('AC2: renders nothing when question is null', () => {
    fixture.componentRef.setInput('question', null);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.question-bubble')).toBeNull();
  });

  it('always offers a free-form "write your own" button', () => {
    fixture.componentRef.setInput('question', makeQuestion());
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.q-opt--freeform')).not.toBeNull();
    expect(el.querySelector('.q-options')).toBeNull();
  });

  it('emits freeform when the write-your-own button is clicked', () => {
    fixture.componentRef.setInput('question', makeQuestion({ options: [{ label: 'Yes' }] }));
    let fired = false;
    fixture.componentInstance.freeform.subscribe(() => (fired = true));
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('.q-opt--freeform') as HTMLButtonElement).click();
    expect(fired).toBe(true);
  });

  it('renders one pill per option, the first one primary', () => {
    fixture.componentRef.setInput('question', makeQuestion({
      options: [{ label: 'Yes' }, { label: 'No' }],
    }));
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const pills = el.querySelectorAll('.q-options .q-opt');
    expect(pills.length).toBe(2);
    expect(pills[0].classList.contains('primary')).toBe(true);
    expect(pills[1].classList.contains('primary')).toBe(false);
  });

  it('renders option descriptions visibly', () => {
    fixture.componentRef.setInput('question', makeQuestion({
      options: [
        { label: 'Vitest', description: 'Rápido, nativo para Vite.' },
        { label: 'Jest', description: 'Ecosistema amplio.' },
      ],
    }));
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelectorAll('.q-opt-desc').length).toBe(2);
    expect(el.textContent).toContain('Rápido, nativo para Vite.');
  });

  it('emits the chosen label when an option pill is clicked', () => {
    fixture.componentRef.setInput('question', makeQuestion({
      options: [{ label: 'Extract everything' }, { label: 'Later' }],
    }));
    let emitted: string | undefined;
    fixture.componentInstance.answer.subscribe((v) => (emitted = v));
    fixture.detectChanges();
    const second = fixture.nativeElement.querySelectorAll('.q-opt')[1] as HTMLButtonElement;
    second.click();
    expect(emitted).toBe('Later');
  });

  it('supports multiple prompts by collecting selections before emitting', () => {
    fixture.componentRef.setInput('question', makeQuestion({
      questions: [
        {
          id: 'framework',
          header: 'Framework',
          question: '¿Qué framework?',
          options: [{ label: 'Vitest' }, { label: 'Jest' }],
        },
        {
          id: 'runner',
          header: 'Runner',
          question: '¿Dónde?',
          options: [{ label: 'CI' }, { label: 'Local' }],
        },
      ],
    }));
    let emitted: string | undefined;
    fixture.componentInstance.answer.subscribe((v) => (emitted = v));
    fixture.detectChanges();

    const buttons = fixture.nativeElement.querySelectorAll('.q-options .q-opt') as NodeListOf<HTMLButtonElement>;
    buttons[0]?.click();
    buttons[2]?.click();
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('.q-actions dv-button button') as HTMLButtonElement).click();

    expect(emitted).toBe('Framework: Vitest\nRunner: CI');
  });

  it('supports multi-select prompts', () => {
    fixture.componentRef.setInput('question', makeQuestion({
      questions: [
        {
          id: 'frameworks',
          header: 'Frameworks',
          question: '¿Cuáles?',
          multiSelect: true,
          options: [{ label: 'Vitest' }, { label: 'Jest' }, { label: 'Mocha' }],
        },
      ],
    }));
    let emitted: string | undefined;
    fixture.componentInstance.answer.subscribe((v) => (emitted = v));
    fixture.detectChanges();

    const buttons = fixture.nativeElement.querySelectorAll('.q-options .q-opt') as NodeListOf<HTMLButtonElement>;
    buttons[0]?.click();
    buttons[2]?.click();
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('.q-actions dv-button button') as HTMLButtonElement).click();

    expect(emitted).toBe('Frameworks: Vitest, Mocha');
  });

  it('has role=status on the card for accessibility', () => {
    fixture.componentRef.setInput('question', makeQuestion());
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[role="status"]')).not.toBeNull();
  });
});
