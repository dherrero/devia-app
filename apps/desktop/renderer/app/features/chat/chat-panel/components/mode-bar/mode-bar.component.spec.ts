import { describe, it, expect, beforeEach } from 'vitest';
import { TestBed, ComponentFixture } from '@angular/core/testing';
import { TranslateModule } from '@ngx-translate/core';
import { ModeBarComponent } from './mode-bar.component';
import { RUN_MODE_OPTIONS, type RunMode } from '../../models/run-mode.model';

describe('ModeBarComponent (HT-MD-01)', () => {
  let fixture: ComponentFixture<ModeBarComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ModeBarComponent, TranslateModule.forRoot()],
    }).compileComponents();
    fixture = TestBed.createComponent(ModeBarComponent);
    fixture.componentRef.setInput('mode', 'apply' as RunMode);
    fixture.detectChanges();
  });

  function el(): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  it('renders one segment per RUN_MODE_OPTIONS entry', () => {
    const segs = el().querySelectorAll('.ds-mode-bar__seg');
    expect(segs.length).toBe(RUN_MODE_OPTIONS.length);
  });

  it('flags the active segment with data-active=true and aria-pressed', () => {
    const active = el().querySelector(
      '.ds-mode-bar__seg[data-active="true"]',
    ) as HTMLButtonElement;
    expect(active).not.toBeNull();
    expect(active.getAttribute('aria-pressed')).toBe('true');
    expect(active.textContent?.trim()).toBe('mode.apply_label');
  });

  it('marks the YOLO segment with the warn modifier', () => {
    const warn = el().querySelector('.ds-mode-bar__seg.ds-mode-bar__seg--warn');
    expect(warn).not.toBeNull();
    expect(warn?.textContent?.trim()).toBe('mode.yolo_label');
  });

  it('emits modeChange when the user clicks a different segment', () => {
    let received: RunMode | null = null;
    fixture.componentInstance.modeChange.subscribe((m) => (received = m));
    const yolo = Array.from(
      el().querySelectorAll<HTMLButtonElement>('.ds-mode-bar__seg'),
    ).find((b) => b.classList.contains('ds-mode-bar__seg--warn')) as HTMLButtonElement;
    yolo.click();
    expect(received).toBe('apply-yolo');
  });

  it('does NOT re-emit when clicking the already-active segment', () => {
    let count = 0;
    fixture.componentInstance.modeChange.subscribe(() => (count += 1));
    const active = el().querySelector(
      '.ds-mode-bar__seg[data-active="true"]',
    ) as HTMLButtonElement;
    active.click();
    expect(count).toBe(0);
  });
});
