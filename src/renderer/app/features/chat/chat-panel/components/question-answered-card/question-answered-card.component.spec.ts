import { describe, it, expect } from 'vitest';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { TranslateModule } from '@ngx-translate/core';
import { QuestionAnsweredCardComponent } from './question-answered-card.component';
import type { ToolCallRecord } from '../../../../../../../shared/domain/chat';

async function mount(toolCall: ToolCallRecord): Promise<ComponentFixture<QuestionAnsweredCardComponent>> {
  await TestBed.configureTestingModule({
    imports: [QuestionAnsweredCardComponent, TranslateModule.forRoot()],
  }).compileComponents();
  const fixture = TestBed.createComponent(QuestionAnsweredCardComponent);
  fixture.componentRef.setInput('toolCall', toolCall);
  fixture.detectChanges();
  return fixture;
}

const PETS_INPUT = {
  questions: [
    {
      question: '¿Prefieres perros o gatos?',
      header: 'Mascota',
      multiSelect: false,
      options: [
        { label: 'Perros', description: 'Leales y sociables.' },
        { label: 'Gatos', description: 'Independientes y tranquilos.' },
      ],
    },
  ],
};

describe('QuestionAnsweredCardComponent', () => {
  it('renders the question text and one pill per option', async () => {
    const fixture = await mount({
      id: 'toolu_1',
      name: 'AskUserQuestion',
      input: PETS_INPUT,
      result: 'Your questions have been answered: "¿Prefieres perros o gatos?"="Perros". You can now continue with these answers in mind.',
    });
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.ds-qa-card__question')?.textContent).toContain('¿Prefieres perros o gatos?');
    expect(el.querySelectorAll('.ds-qa-card__opt').length).toBe(2);
    expect(el.querySelector('.ds-qa-card__header')?.textContent?.trim()).toBe('Mascota');
  });

  it("marks the chosen option as selected from Claude's canned result", async () => {
    const fixture = await mount({
      id: 'toolu_1',
      name: 'AskUserQuestion',
      input: PETS_INPUT,
      result: 'Your questions have been answered: "¿Prefieres perros o gatos?"="Perros". You can now continue with these answers in mind.',
    });
    const el = fixture.nativeElement as HTMLElement;
    const selected = el.querySelectorAll('.ds-qa-card__opt--selected');
    expect(selected.length).toBe(1);
    expect(selected[0].textContent).toContain('Perros');
    expect(el.querySelector('.ds-qa-card__free')).toBeNull();
  });

  it('marks the chosen option from a raw answer result (non-Claude agents)', async () => {
    const fixture = await mount({
      id: 'toolu_2',
      name: 'AskUserQuestion',
      input: PETS_INPUT,
      result: 'Gatos',
    });
    const el = fixture.nativeElement as HTMLElement;
    const selected = el.querySelectorAll('.ds-qa-card__opt--selected');
    expect(selected.length).toBe(1);
    expect(selected[0].textContent).toContain('Gatos');
  });

  it('shows a free-form answer chip when the answer matches no option', async () => {
    const fixture = await mount({
      id: 'toolu_3',
      name: 'AskUserQuestion',
      input: PETS_INPUT,
      result: 'Prefiero los hurones',
    });
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelectorAll('.ds-qa-card__opt--selected').length).toBe(0);
    expect(el.querySelector('.ds-qa-card__free-text')?.textContent).toBe('Prefiero los hurones');
  });

  it('selects every chosen option on a multi-select answer', async () => {
    const fixture = await mount({
      id: 'toolu_4',
      name: 'AskUserQuestion',
      input: {
        questions: [
          {
            question: 'Pick languages',
            header: 'Langs',
            multiSelect: true,
            options: [{ label: 'TS' }, { label: 'Rust' }, { label: 'Go' }],
          },
        ],
      },
      result: 'Langs: TS, Go',
    });
    const el = fixture.nativeElement as HTMLElement;
    const selected = Array.from(el.querySelectorAll('.ds-qa-card__opt--selected'));
    expect(selected.map((s) => s.textContent?.trim())).toEqual(['TS', 'Go']);
  });

  it('renders one section per prompt on multi-question calls', async () => {
    const fixture = await mount({
      id: 'toolu_5',
      name: 'AskUserQuestion',
      input: {
        questions: [
          { question: 'Pet?', header: 'Pet', options: [{ label: 'Dog' }, { label: 'Cat' }] },
          { question: 'Color?', header: 'Color', options: [{ label: 'Red' }, { label: 'Blue' }] },
        ],
      },
      result: 'Your questions have been answered: "Pet?"="Dog", "Color?"="Blue". You can now continue with these answers in mind.',
    });
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelectorAll('.ds-qa-card__prompt').length).toBe(2);
    const selected = Array.from(el.querySelectorAll('.ds-qa-card__opt--selected'));
    expect(selected.map((s) => s.textContent?.trim())).toEqual(['Dog', 'Blue']);
  });
});
