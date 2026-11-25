/**
 * S-54 — the card an agent failure is shown in: title, cause, one button per
 * action, and the raw message folded into the details.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed, ComponentFixture } from '@angular/core/testing';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { AgentErrorCardComponent } from './agent-error-card.component';
import { ElectronApiService } from '../../../../../core/services/electron-api.service';
import { KeyboardShortcutsService } from '../../../../../core/layout/keyboard-shortcuts.service';
import { ToastService } from '../../../../../core/services/toast.service';
import type { UserFacingError } from '../../../../../../../shared/domain/user-facing-error';

const error = (over: Partial<UserFacingError> = {}): UserFacingError => ({
  code: 'invalid_provider_key',
  variant: 'default_env',
  params: { agent: 'PI', envVar: 'OPENAI_API_KEY' },
  title: 'fallback title',
  cause: 'fallback cause',
  actions: [{ kind: 'pick_model' }, { kind: 'open_settings', section: 'execution' }, { kind: 'copy_details' }],
  details: 'OpenAI API error (401): raw provider text',
  ...over,
});

describe('AgentErrorCardComponent', () => {
  let fixture: ComponentFixture<AgentErrorCardComponent>;
  const openSettings = vi.fn();
  const getConfig = vi.fn();
  const setConfig = vi.fn();
  const toast = vi.fn();
  const el = (): HTMLElement => fixture.nativeElement as HTMLElement;
  const buttons = (): HTMLElement[] => Array.from(el().querySelectorAll('.agent-error-card__actions dv-button'));

  beforeEach(async () => {
    vi.clearAllMocks();
    getConfig.mockResolvedValue({ autoContinueSessions: { codex: true } });
    setConfig.mockResolvedValue(undefined);
    await TestBed.configureTestingModule({
      imports: [AgentErrorCardComponent, TranslateModule.forRoot()],
      providers: [
        { provide: ElectronApiService, useValue: { getConfig, setConfig } },
        { provide: KeyboardShortcutsService, useValue: { openSettings } },
        { provide: ToastService, useValue: { show: toast } },
      ],
    }).compileComponents();
    TestBed.inject(TranslateService).setTranslation('en', {
      agent_error: {
        details: 'Technical details',
        actions: { pick_model: 'Choose a model', open_settings: 'Open settings', copy_details: 'Copy details', retry: 'Retry', enable_auto_continue: 'Turn on auto-continue' },
        invalid_provider_key: {
          title: 'The provider API key is not valid',
          cause_default_env: '{{agent}} used its default; fix {{envVar}}.',
        },
      },
    });
    TestBed.inject(TranslateService).use('en');
    fixture = TestBed.createComponent(AgentErrorCardComponent);
  });

  const render = (e: UserFacingError): void => {
    fixture.componentRef.setInput('error', e);
    fixture.detectChanges();
  };

  it('shows the translated title and the variant cause with its params', () => {
    render(error());
    expect(el().querySelector('.agent-error-card__title')?.textContent).toContain('The provider API key is not valid');
    expect(el().querySelector('.agent-error-card__cause')?.textContent).toContain('PI used its default; fix OPENAI_API_KEY.');
  });

  it('falls back to the main-side text for a code without translations', () => {
    render(error({ code: 'brand_new', variant: undefined as unknown as string }));
    expect(el().querySelector('.agent-error-card__title')?.textContent).toContain('fallback title');
    expect(el().querySelector('.agent-error-card__cause')?.textContent).toContain('fallback cause');
  });

  it('keeps the raw provider text in the folded details, closed by default', () => {
    render(error());
    const details = el().querySelector('details') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(details.querySelector('pre')?.textContent).toContain('raw provider text');
  });

  it('renders one button per action plus copy, and opens Settings › Execution for pick_model', async () => {
    render(error());
    expect(buttons().length).toBe(3);
    await fixture.componentInstance.run({ kind: 'pick_model' });
    expect(openSettings).toHaveBeenCalledWith('execution');
  });

  it('retry asks the panel to re-send', async () => {
    render(error({ actions: [{ kind: 'retry' }] }));
    const spy = vi.fn();
    fixture.componentInstance.retry.subscribe(spy);
    await fixture.componentInstance.run({ kind: 'retry' });
    expect(spy).toHaveBeenCalledOnce();
  });

  it('enable_auto_continue switches the agent on without dropping the other agents', async () => {
    render(error({ actions: [{ kind: 'enable_auto_continue', agentId: 'claude' }] }));
    await fixture.componentInstance.run({ kind: 'enable_auto_continue', agentId: 'claude' });
    expect(setConfig).toHaveBeenCalledWith({ autoContinueSessions: { codex: true, claude: true } });
    expect(toast).toHaveBeenCalled();
  });

  it('shows no action row for a Telegram-style error without actions', () => {
    render(error({ actions: [] }));
    expect(el().querySelector('.agent-error-card__actions')).toBeNull();
  });
});
