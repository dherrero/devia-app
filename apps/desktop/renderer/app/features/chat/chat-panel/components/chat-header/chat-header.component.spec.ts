import { describe, it, expect, beforeEach } from 'vitest';
import { TestBed, ComponentFixture } from '@angular/core/testing';
import { TranslateModule } from '@ngx-translate/core';
import { ChatHeaderComponent } from './chat-header.component';
import type { ChatView } from '../../models/chat-view.model';

describe('ChatHeaderComponent (HT-CH-02)', () => {
  let fixture: ComponentFixture<ChatHeaderComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ChatHeaderComponent, TranslateModule.forRoot()],
    }).compileComponents();
    fixture = TestBed.createComponent(ChatHeaderComponent);
    fixture.componentRef.setInput('projectName', 'devia');
    fixture.componentRef.setInput('projectPath', '/ws/devia');
    fixture.componentRef.setInput('view', 'chat' as ChatView);
    fixture.componentRef.setInput('running', false);
    fixture.detectChanges();
  });

  function el(): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  it('renders the project name and the ~/<folder> path hint', () => {
    expect(el().querySelector('.ds-chat-header__name')?.textContent?.trim()).toBe('devia');
    expect(el().querySelector('.ds-chat-header__path')?.textContent?.trim()).toBe('~/devia');
  });

  it('puts the absolute path on the title attribute so truncated values stay reachable', () => {
    const longPath = '/very/deep/folder/structure/that/will/truncate';
    fixture.componentRef.setInput('projectPath', longPath);
    fixture.detectChanges();
    const name = el().querySelector('.ds-chat-header__name') as HTMLElement;
    expect(name.getAttribute('title')).toBe(longPath);
  });

  it('shows the changes count as an accent badge on the Cambios tab', () => {
    fixture.componentRef.setInput('changesCount', 7);
    fixture.detectChanges();
    const badge = el().querySelector('.dv-tabs__badge');
    expect(badge?.textContent?.trim()).toBe('7');
  });

  it('hides the changes badge when there are no changes', () => {
    expect(el().querySelector('.dv-tabs__badge')).toBeNull();
  });

  it('mounts dv-tabs with the pill variant', () => {
    const tabs = el().querySelector('dv-tabs') as HTMLElement;
    expect(tabs).not.toBeNull();
    expect(tabs.classList.contains('dv-tabs--pill')).toBe(true);
  });

  it('lights up the active tab from the [view] input', () => {
    const buttons = el().querySelectorAll<HTMLButtonElement>('[role="tab"]');
    expect(buttons.length).toBe(2);
    const initiallyActive = Array.from(buttons).find(
      (b) => b.getAttribute('aria-selected') === 'true',
    );
    expect(initiallyActive?.id).toBe('tab-chat');
  });

  it('emits viewChange when the user clicks the other tab', () => {
    let received: ChatView | null = null;
    fixture.componentInstance.viewChange.subscribe((v) => (received = v));
    const changesBtn = el().querySelector('[id="tab-changes"]') as HTMLButtonElement;
    changesBtn.click();
    expect(received).toBe('changes');
  });

  it('hides the running badge by default', () => {
    expect(el().querySelector('dv-badge')).toBeNull();
  });

  it('shows the running badge with the pulsing dot when [running]=true', () => {
    fixture.componentRef.setInput('running', true);
    fixture.detectChanges();
    expect(el().querySelector('dv-badge')).not.toBeNull();
    expect(el().querySelector('.ds-chat-header__working-dot')).not.toBeNull();
  });

  it('hides the no-isolation warning icon by default', () => {
    expect(el().querySelector('.ds-chat-header__no-isolation')).toBeNull();
  });

  it('S-3 F1.1: shows the warning icon next to the name when [unisolated]=true', () => {
    fixture.componentRef.setInput('unisolated', true);
    fixture.detectChanges();
    const icon = el().querySelector('.ds-chat-header__no-isolation');
    expect(icon).not.toBeNull();
    expect(icon?.closest('.ds-chat-header__name-row')).not.toBeNull();
  });
});
