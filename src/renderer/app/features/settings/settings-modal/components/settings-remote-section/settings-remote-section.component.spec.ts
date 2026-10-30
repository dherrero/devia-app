import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { TranslateModule } from '@ngx-translate/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ElectronApiService } from '../../../../../core/services/electron-api.service';
import type { RemoteForm } from '../../models/settings-forms.model';
import { SettingsRemoteSectionComponent } from './settings-remote-section.component';

const remoteControlGetStatus = vi.fn(async () => ({ state: 'disabled' as const }));
const remoteControlTest = vi.fn();

function form(overrides: Partial<RemoteForm> = {}): RemoteForm {
  return {
    enabled: true,
    botToken: 't',
    chatId: '1',
    allowShell: false,
    mirrorDesktop: false,
    allowFileSend: true,
    ...overrides,
  };
}

async function mount(initial: RemoteForm): Promise<{
  fixture: ComponentFixture<SettingsRemoteSectionComponent>;
  detect: () => Promise<void>;
  fileSendSwitch: () => HTMLButtonElement;
}> {
  const fixture = TestBed.createComponent(SettingsRemoteSectionComponent);
  fixture.componentRef.setInput('remoteForm', initial);
  const detect = async (): Promise<void> => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };
  await detect();
  const fileSendSwitch = (): HTMLButtonElement => {
    const el = (fixture.nativeElement as HTMLElement).querySelector(
      '[data-testid="remote-allow-file-send"] button[role="switch"]',
    );
    if (!el) throw new Error('allowFileSend toggle not rendered');
    return el as HTMLButtonElement;
  };
  return { fixture, detect, fileSendSwitch };
}

describe('SettingsRemoteSectionComponent — allowFileSend (S-32 T-370)', () => {
  beforeEach(() => {
    remoteControlGetStatus.mockClear();
    TestBed.configureTestingModule({
      imports: [SettingsRemoteSectionComponent, TranslateModule.forRoot()],
      providers: [
        { provide: ElectronApiService, useValue: { remoteControlGetStatus, remoteControlTest } },
      ],
    });
  });

  it('reflects the current value of allowFileSend', async () => {
    const { fileSendSwitch } = await mount(form({ allowFileSend: true }));

    expect(fileSendSwitch().getAttribute('aria-checked')).toBe('true');
  });

  it('toggling writes allowFileSend into the form, leaving other fields intact', async () => {
    const { fixture, detect, fileSendSwitch } = await mount(form({ allowFileSend: true, allowShell: true }));

    fileSendSwitch().click();
    await detect();

    expect(fixture.componentInstance.remoteForm()).toEqual(form({ allowFileSend: false, allowShell: true }));

    fileSendSwitch().click();
    await detect();

    expect(fixture.componentInstance.remoteForm().allowFileSend).toBe(true);
  });

  it('is disabled while Telegram is not enabled', async () => {
    const { fixture, detect, fileSendSwitch } = await mount(form({ enabled: false }));

    expect(fileSendSwitch().disabled).toBe(true);
    fileSendSwitch().click();
    await detect();
    expect(fixture.componentInstance.remoteForm().allowFileSend).toBe(true);
  });

  it('becomes usable once Telegram is enabled', async () => {
    const { fixture, detect, fileSendSwitch } = await mount(form({ enabled: false }));

    fixture.componentInstance.updateRemoteForm('enabled', true);
    await detect();

    expect(fileSendSwitch().disabled).toBe(false);
  });
});
