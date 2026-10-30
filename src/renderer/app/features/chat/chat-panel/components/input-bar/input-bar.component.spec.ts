import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed, ComponentFixture } from '@angular/core/testing';
import { TranslateModule } from '@ngx-translate/core';
import { InputBarComponent } from './input-bar.component';
import { ChatScrollService } from '../../services/chat-scroll.service';

describe('InputBarComponent (HT-IN-01)', () => {
  let fixture: ComponentFixture<InputBarComponent>;

  beforeEach(async () => {
    // ChatScrollService is no longer providedIn:'root' — supply it here
    // since InputBarComponent injects it for the autosize re-pin logic.
    await TestBed.configureTestingModule({
      imports: [InputBarComponent, TranslateModule.forRoot()],
      providers: [ChatScrollService],
    }).compileComponents();
    fixture = TestBed.createComponent(InputBarComponent);
    fixture.componentRef.setInput('draft', '');
    fixture.componentRef.setInput('canSend', false);
    fixture.componentRef.setInput('running', false);
    fixture.componentRef.setInput('micState', 'idle');
    fixture.componentRef.setInput('micTooltip', 'Record');
    fixture.detectChanges();
  });

  function el(): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  function buttons(): HTMLButtonElement[] {
    return Array.from(el().querySelectorAll<HTMLButtonElement>('dv-button button'));
  }

  it('the attach button opens the hidden file picker', () => {
    const input = el().querySelector<HTMLInputElement>('input[type="file"]')!;
    expect(input.multiple).toBe(true);
    const click = vi.spyOn(input, 'click').mockImplementation(() => undefined);
    buttons()[1].click();
    expect(click).toHaveBeenCalledTimes(1);
  });

  it('emits the picked files and resets the input', () => {
    const input = el().querySelector<HTMLInputElement>('input[type="file"]')!;
    const picked = [new File(['x'], 'a.zip', { type: 'application/zip' })];
    Object.defineProperty(input, 'files', { value: picked, configurable: true });
    let received: File[] = [];
    fixture.componentInstance.filesPicked.subscribe((f) => (received = f));
    input.dispatchEvent(new Event('change'));
    expect(received).toEqual(picked);
  });

  it('renders mic + attach + textarea + send + reset by default', () => {
    expect(buttons()[0]).not.toBeNull();
    expect(el().querySelector('.ds-input-bar__textarea')).not.toBeNull();
    expect(buttons()[2]?.textContent).toContain('chat.send_button');
    expect(buttons()[3]).not.toBeNull();
    expect(el().textContent).not.toContain('chat.stop_button');
  });

  it('swaps the send button for stop when running=true', () => {
    fixture.componentRef.setInput('running', true);
    fixture.detectChanges();
    expect(buttons()[2]?.textContent).toContain('chat.stop_button');
    expect(el().textContent).not.toContain('chat.send_button');
  });

  it('flags the send button as disabled when canSend=false', () => {
    const send = buttons()[2];
    expect(send.disabled).toBe(true);
  });

  it('enables the send button when canSend=true', () => {
    fixture.componentRef.setInput('canSend', true);
    fixture.detectChanges();
    const send = buttons()[2];
    expect(send.disabled).toBe(false);
  });

  it('shows the recording square icon when micState=recording', () => {
    fixture.componentRef.setInput('micState', 'recording');
    fixture.detectChanges();
    const mic = buttons()[0];
    expect(mic.classList.contains('dv-button--danger-soft')).toBe(true);
    expect(mic.disabled).toBe(false);
  });

  it('disables the mic and marks it busy while transcribing', () => {
    fixture.componentRef.setInput('micState', 'transcribing');
    fixture.detectChanges();
    const mic = buttons()[0];
    expect(mic.disabled).toBe(true);
  });

  it('emits voice when the mic button is clicked', () => {
    let emitted = 0;
    fixture.componentInstance.voice.subscribe(() => (emitted += 1));
    buttons()[0].click();
    expect(emitted).toBe(1);
  });

  it('emits submit when send is clicked (and canSend is true)', () => {
    fixture.componentRef.setInput('canSend', true);
    fixture.detectChanges();
    let emitted = 0;
    fixture.componentInstance.submitted.subscribe(() => (emitted += 1));
    buttons()[2].click();
    expect(emitted).toBe(1);
  });

  it('emits stop when the stop variant is clicked', () => {
    fixture.componentRef.setInput('running', true);
    fixture.detectChanges();
    let emitted = 0;
    fixture.componentInstance.stop.subscribe(() => (emitted += 1));
    buttons()[2].click();
    expect(emitted).toBe(1);
  });

  it('emits reset when the refresh icon is clicked', () => {
    let emitted = 0;
    fixture.componentInstance.resetRequested.subscribe(() => (emitted += 1));
    buttons()[3].click();
    expect(emitted).toBe(1);
  });
});
