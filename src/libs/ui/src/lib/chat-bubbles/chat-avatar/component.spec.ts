import { ComponentFixture, TestBed } from '@angular/core/testing';
import {
  DvChatAvatarComponent,
  type DvChatAvatarSpeakFrames,
  type DvChatAvatarState,
} from './component';

const pair = (n: string) => ({ open: `${n}.png`, blink: `${n}_blink.png` });
const FRAMES: DvChatAvatarSpeakFrames = {
  consonants: pair('c'),
  a: pair('a'),
  ei: pair('ei'),
  ou: pair('ou'),
};

describe('DvChatAvatarComponent', () => {
  let fixture: ComponentFixture<DvChatAvatarComponent>;
  const el = () => fixture.nativeElement as HTMLElement;

  function render(state: DvChatAvatarState, active = true, speak = true): void {
    fixture.componentRef.setInput('variant', 'ai');
    fixture.componentRef.setInput('imageSrc', 'open.png');
    fixture.componentRef.setInput('blinkSrc', 'blink.png');
    fixture.componentRef.setInput('speakFrames', speak ? FRAMES : null);
    fixture.componentRef.setInput('state', state);
    fixture.componentRef.setInput('active', active);
    fixture.detectChanges();
  }

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [DvChatAvatarComponent] });
    fixture = TestBed.createComponent(DvChatAvatarComponent);
  });

  it('renders only the open frame plus the blink twin at rest', () => {
    render('idle');
    expect(el().querySelectorAll('.dv-chat-avatar__mouth').length).toBe(0);
    expect(el().querySelector('.dv-chat-avatar__blink')).not.toBeNull();
  });

  it('cycles the four mouth poses, open and closed-eye, while streaming', () => {
    render('streaming');
    expect(el().querySelectorAll('.dv-chat-avatar__mouth').length).toBe(8);
  });

  it('does not speak while thinking or running tools', () => {
    for (const state of ['thinking', 'tool', 'searching'] as const) {
      render(state);
      expect(el().querySelectorAll('.dv-chat-avatar__mouth').length).toBe(0);
    }
  });

  it('keeps history avatars static: only the base frame', () => {
    render('streaming', false);
    expect(el().querySelectorAll('.dv-chat-avatar__mouth').length).toBe(0);
    expect(el().querySelector('.dv-chat-avatar__blink')).toBeNull();
  });

  it('does not speak without speak frames', () => {
    render('streaming', true, false);
    expect(el().querySelectorAll('.dv-chat-avatar__mouth').length).toBe(0);
  });
});
