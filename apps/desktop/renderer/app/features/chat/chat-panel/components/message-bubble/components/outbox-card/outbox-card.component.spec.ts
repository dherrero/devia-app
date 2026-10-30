import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { TranslateModule } from '@ngx-translate/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatMessage } from '../../../../../../../../../shared/domain/chat';
import { ElectronApiService } from '../../../../../../../core/services/electron-api.service';
import { OutboxCardComponent } from './outbox-card.component';

const openPath = vi.fn(() => Promise.resolve(''));
const revealInFolder = vi.fn(() => Promise.resolve(true as const));

function outbox(over: Partial<ChatMessage> = {}): ChatMessage {
  return { id: 'o1', role: 'outbox', name: 'README.md', kind: 'file', path: '/repo/README.md', ...over };
}

describe('OutboxCardComponent', () => {
  let fixture: ComponentFixture<OutboxCardComponent>;

  beforeEach(() => {
    openPath.mockClear();
    revealInFolder.mockClear();
    TestBed.configureTestingModule({
      imports: [OutboxCardComponent, TranslateModule.forRoot()],
      providers: [{ provide: ElectronApiService, useValue: { openPath, revealInFolder } }],
    });
    fixture = TestBed.createComponent(OutboxCardComponent);
  });

  function render(msg: ChatMessage): HTMLElement {
    fixture.componentRef.setInput('msg', msg);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  it('shows the neutral "for Telegram" badge, with the delivery hint, for a devia_send_file file', () => {
    const el = render(outbox({ channel: 'telegram' }));

    const badge = el.querySelector('[data-testid="outbox-for-telegram"]');
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toContain('chat.outbox.for_telegram');
    expect(badge?.getAttribute('title')).toBe('chat.outbox.for_telegram_hint');
  });

  it('shows no badge for a plain outbox file', () => {
    const el = render(outbox());

    expect(el.querySelector('[data-testid="outbox-for-telegram"]')).toBeNull();
  });

  it('opens and reveals the absolute path, even outside the outbox archive', () => {
    const el = render(outbox({ channel: 'telegram' }));
    const buttons = el.querySelectorAll('.actions button');
    expect(buttons.length).toBe(2);

    (buttons[0] as HTMLButtonElement).click();
    (buttons[1] as HTMLButtonElement).click();

    expect(openPath).toHaveBeenCalledWith('/repo/README.md');
    expect(revealInFolder).toHaveBeenCalledWith('/repo/README.md');
  });
});
