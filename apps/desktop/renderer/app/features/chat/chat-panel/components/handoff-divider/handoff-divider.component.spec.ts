import { describe, it, expect, beforeEach } from 'vitest';
import { TestBed, ComponentFixture } from '@angular/core/testing';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { HandoffDividerComponent } from './handoff-divider.component';
import type { ChatMessage } from '../../../../../../../shared/domain/chat';

function handoffMsg(over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'h-1',
    role: 'assistant',
    kind: 'handoff',
    handoff: { fromAgentId: 'codex', toAgentId: 'claude' },
    text: '## Continuación de sesión iniciada con codex',
    ...over,
  } as ChatMessage;
}

describe('HandoffDividerComponent (S-2 F3.2)', () => {
  let fixture: ComponentFixture<HandoffDividerComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [HandoffDividerComponent, TranslateModule.forRoot()],
    }).compileComponents();
    const translate = TestBed.inject(TranslateService);
    translate.setTranslation('en', {
      chat: {
        handoff_title: 'Session started with {{from}} · continued with {{to}}',
        handoff_toggle: 'View handed-off context',
        handoff_toggle_hide: 'Hide context',
      },
    });
    translate.use('en');
    fixture = TestBed.createComponent(HandoffDividerComponent);
  });

  function el(): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  function mount(msg: ChatMessage = handoffMsg()): void {
    fixture.componentRef.setInput('msg', msg);
    fixture.detectChanges();
  }

  it('renders a separator naming both agents, with the summary collapsed by default', () => {
    mount();

    const sep = el().querySelector('[role="separator"]');
    expect(sep).not.toBeNull();
    expect(sep?.getAttribute('aria-label')).toContain('Codex');
    expect(sep?.getAttribute('aria-label')).toContain('Claude Code');
    expect(el().textContent).toContain('Session started with Codex · continued with Claude Code');
    expect(el().querySelector('.ds-handoff__summary')).toBeNull();
  });

  it('expands the summary through a real button with aria-expanded', () => {
    mount();

    const btn = el().querySelector<HTMLButtonElement>('button.ds-handoff__toggle');
    expect(btn).not.toBeNull();
    expect(btn?.getAttribute('aria-expanded')).toBe('false');

    btn!.click();
    fixture.detectChanges();

    expect(btn?.getAttribute('aria-expanded')).toBe('true');
    const summary = el().querySelector('.ds-handoff__summary');
    expect(summary).not.toBeNull();
    expect(summary?.textContent).toContain('Continuación de sesión iniciada con codex');
  });

  it('never renders raw script tags from the summary markdown', () => {
    mount(handoffMsg({ text: 'hola <script>window.x=1</script> mundo' }));

    el().querySelector<HTMLButtonElement>('button.ds-handoff__toggle')!.click();
    fixture.detectChanges();

    expect(el().querySelector('script')).toBeNull();
  });

  it('falls back to the raw agent id when the catalog has no label', () => {
    mount(handoffMsg({ handoff: { fromAgentId: 'deepseek', toAgentId: 'claude' } }));
    expect(el().textContent).toContain('deepseek');
  });
});
