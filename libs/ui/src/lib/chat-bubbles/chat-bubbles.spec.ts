import { ComponentFixture, TestBed } from '@angular/core/testing';
import { DvChatFeedComponent } from './chat-feed';
import { DvChatAvatarComponent, type DvChatAvatarState } from './chat-avatar';
import { DvChatMessageComponent } from './chat-message';
import { DvChatStatusBadgeComponent } from './chat-status-badge';
import { DvChoiceCardComponent } from './choice-card';
import { DvDiffViewComponent } from './diff-view';
import { DvErrorBubbleComponent } from './error-bubble';
import type { DvChatMessage, DvChoiceOption } from './models';
import { DvThinkingBlockComponent } from './thinking-block';
import { DvToolCallCardComponent } from './tool-call-card';

describe('chat bubble components', () => {
  describe('DvChatAvatarComponent', () => {
    it('reflects the full 15-state avatar contract on the host', async () => {
      await TestBed.configureTestingModule({
        imports: [DvChatAvatarComponent],
      }).compileComponents();

      const fixture = TestBed.createComponent(DvChatAvatarComponent);
      const states: DvChatAvatarState[] = [
        'idle',
        'paused',
        'offline',
        'listening',
        'asking',
        'thinking',
        'planning',
        'searching',
        'tool',
        'writing',
        'terminal',
        'streaming',
        'success',
        'error',
        'warning',
      ];

      fixture.componentRef.setInput('variant', 'ai');
      fixture.componentRef.setInput(
        'imageSrc',
        'assets/images/devia-mascot-pixel.png',
      );

      for (const state of states) {
        fixture.componentRef.setInput('state', state);
        fixture.detectChanges();
        expect(fixture.nativeElement.getAttribute('data-state')).toBe(state);
      }
    });

    it('reflects whether the avatar is the active animated turn', async () => {
      await TestBed.configureTestingModule({
        imports: [DvChatAvatarComponent],
      }).compileComponents();

      const fixture = TestBed.createComponent(DvChatAvatarComponent);
      fixture.componentRef.setInput('variant', 'ai');
      fixture.componentRef.setInput('active', false);
      fixture.detectChanges();

      expect(fixture.nativeElement.getAttribute('data-active')).toBe('false');
    });
  });

  describe('DvChatFeedComponent', () => {
    let fixture: ComponentFixture<DvChatFeedComponent>;

    beforeEach(async () => {
      await TestBed.configureTestingModule({
        imports: [DvChatFeedComponent],
      }).compileComponents();

      fixture = TestBed.createComponent(DvChatFeedComponent);
    });

    it('renders a polite conversation log', () => {
      const messages: DvChatMessage[] = [
        { id: 'u1', type: 'user', content: 'Hola' },
        { id: 's1', type: 'system', content: 'Sesion iniciada' },
      ];
      fixture.componentRef.setInput('messages', messages);
      fixture.detectChanges();

      const log = fixture.nativeElement.querySelector(
        '.dv-chat-feed',
      ) as HTMLElement;
      expect(log.getAttribute('role')).toBe('log');
      expect(log.getAttribute('aria-live')).toBe('polite');
      expect(
        fixture.nativeElement.querySelectorAll('dv-chat-message').length,
      ).toBe(2);
    });
  });

  describe('DvChatMessageComponent', () => {
    it('discriminates tool messages', async () => {
      await TestBed.configureTestingModule({
        imports: [DvChatMessageComponent],
      }).compileComponents();

      const fixture = TestBed.createComponent(DvChatMessageComponent);
      fixture.componentRef.setInput('message', {
        id: 't1',
        type: 'tool',
        toolName: 'Read',
        toolArg: 'src/app.ts',
        toolStatus: 'ok',
      } satisfies DvChatMessage);
      fixture.detectChanges();

      expect(
        fixture.nativeElement.querySelector('dv-tool-call-card'),
      ).toBeTruthy();
    });
  });

  describe('DvToolCallCardComponent', () => {
    let fixture: ComponentFixture<DvToolCallCardComponent>;

    beforeEach(async () => {
      await TestBed.configureTestingModule({
        imports: [DvToolCallCardComponent],
      }).compileComponents();

      fixture = TestBed.createComponent(DvToolCallCardComponent);
      fixture.componentRef.setInput('name', 'Bash');
      fixture.componentRef.setInput('arg', 'npm test');
      fixture.componentRef.setInput('status', 'running');
      fixture.componentRef.setInput('body', 'running tests');
      fixture.detectChanges();
    });

    it('starts collapsed and exposes aria-expanded', () => {
      const button = fixture.nativeElement.querySelector(
        '.dv-tool-header',
      ) as HTMLButtonElement;
      expect(button.getAttribute('aria-expanded')).toBe('false');
      expect(fixture.nativeElement.querySelector('.dv-tool-body')).toBeNull();
    });

    it('toggles body content', () => {
      const button = fixture.nativeElement.querySelector(
        '.dv-tool-header',
      ) as HTMLButtonElement;
      button.click();
      fixture.detectChanges();

      expect(button.getAttribute('aria-expanded')).toBe('true');
      expect(
        fixture.nativeElement.querySelector('.dv-tool-body')?.textContent,
      ).toContain('running tests');
    });
  });

  describe('DvChoiceCardComponent', () => {
    it('emits selected option', async () => {
      await TestBed.configureTestingModule({
        imports: [DvChoiceCardComponent],
      }).compileComponents();

      const fixture = TestBed.createComponent(DvChoiceCardComponent);
      const option: DvChoiceOption = { label: 'Aplicar', isPrimary: true };
      const spy = vi.fn();
      fixture.componentRef.setInput('question', 'Que hacemos?');
      fixture.componentRef.setInput('options', [option]);
      fixture.componentInstance.selected.subscribe(spy);
      fixture.detectChanges();

      (
        fixture.nativeElement.querySelector(
          '.dv-choice-opt',
        ) as HTMLButtonElement
      ).click();
      expect(spy).toHaveBeenCalledWith(option);
    });
  });

  describe('DvThinkingBlockComponent', () => {
    it('toggles aria-expanded and content', async () => {
      await TestBed.configureTestingModule({
        imports: [DvThinkingBlockComponent],
      }).compileComponents();

      const fixture = TestBed.createComponent(DvThinkingBlockComponent);
      fixture.componentRef.setInput('content', 'Analizando');
      fixture.detectChanges();
      const button = fixture.nativeElement.querySelector(
        '.dv-thinking-header',
      ) as HTMLButtonElement;

      expect(button.getAttribute('aria-expanded')).toBe('false');
      button.click();
      fixture.detectChanges();

      expect(button.getAttribute('aria-expanded')).toBe('true');
      expect(
        fixture.nativeElement.querySelector('.dv-thinking-body')?.textContent,
      ).toContain('Analizando');
    });
  });

  describe('DvErrorBubbleComponent', () => {
    it('emits retry', async () => {
      await TestBed.configureTestingModule({
        imports: [DvErrorBubbleComponent],
      }).compileComponents();

      const fixture = TestBed.createComponent(DvErrorBubbleComponent);
      const spy = vi.fn();
      fixture.componentRef.setInput('message', 'Error');
      fixture.componentInstance.retry.subscribe(spy);
      fixture.detectChanges();

      (
        fixture.nativeElement.querySelector(
          '.dv-error-retry',
        ) as HTMLButtonElement
      ).click();
      expect(spy).toHaveBeenCalledOnce();
    });

    it('hides retry when disabled', async () => {
      await TestBed.configureTestingModule({
        imports: [DvErrorBubbleComponent],
      }).compileComponents();

      const fixture = TestBed.createComponent(DvErrorBubbleComponent);
      fixture.componentRef.setInput('message', 'Error');
      fixture.componentRef.setInput('showRetry', false);
      fixture.detectChanges();

      expect(fixture.nativeElement.querySelector('.dv-error-retry')).toBeNull();
    });

    it('hides continue by default', async () => {
      await TestBed.configureTestingModule({
        imports: [DvErrorBubbleComponent],
      }).compileComponents();

      const fixture = TestBed.createComponent(DvErrorBubbleComponent);
      fixture.componentRef.setInput('message', 'Error');
      fixture.detectChanges();

      expect(
        fixture.nativeElement.querySelector('.dv-error-continue'),
      ).toBeNull();
    });

    it('emits continueRun when continue is shown and clicked', async () => {
      await TestBed.configureTestingModule({
        imports: [DvErrorBubbleComponent],
      }).compileComponents();

      const fixture = TestBed.createComponent(DvErrorBubbleComponent);
      const spy = vi.fn();
      fixture.componentRef.setInput('message', 'Error');
      fixture.componentRef.setInput('showContinue', true);
      fixture.componentInstance.continueRun.subscribe(spy);
      fixture.detectChanges();

      (
        fixture.nativeElement.querySelector(
          '.dv-error-continue',
        ) as HTMLButtonElement
      ).click();
      expect(spy).toHaveBeenCalledOnce();
    });
  });

  describe('DvDiffViewComponent', () => {
    it('renders add and delete rows', async () => {
      await TestBed.configureTestingModule({
        imports: [DvDiffViewComponent],
      }).compileComponents();

      const fixture = TestBed.createComponent(DvDiffViewComponent);
      fixture.componentRef.setInput('lines', [
        { type: 'add', lineNum: '+1', code: 'added' },
        { type: 'del', lineNum: '-1', code: 'removed' },
      ]);
      fixture.detectChanges();

      expect(
        fixture.nativeElement.querySelector('.dv-diff-row--add'),
      ).toBeTruthy();
      expect(
        fixture.nativeElement.querySelector('.dv-diff-row--del'),
      ).toBeTruthy();
    });
  });

  describe('DvChatStatusBadgeComponent', () => {
    it('applies status class', async () => {
      await TestBed.configureTestingModule({
        imports: [DvChatStatusBadgeComponent],
      }).compileComponents();

      const fixture = TestBed.createComponent(DvChatStatusBadgeComponent);
      fixture.componentRef.setInput('status', 'error');
      fixture.detectChanges();

      expect(fixture.nativeElement.className).toContain(
        'dv-chat-status-badge--error',
      );
    });
  });
});
