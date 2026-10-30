import { describe, it, expect, beforeEach } from 'vitest';
import { TestBed, ComponentFixture } from '@angular/core/testing';
import { TranslateModule } from '@ngx-translate/core';
import { TokenMeterComponent } from './token-meter.component';

describe('TokenMeterComponent (HT-C-03)', () => {
  let fixture: ComponentFixture<TokenMeterComponent>;

  function set(used: number, limit: number, model: string | null = null): void {
    fixture.componentRef.setInput('used', used);
    fixture.componentRef.setInput('limit', limit);
    fixture.componentRef.setInput('modelLabel', model);
    fixture.detectChanges();
  }

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [TokenMeterComponent, TranslateModule.forRoot()],
    }).compileComponents();
    fixture = TestBed.createComponent(TokenMeterComponent);
  });

  it('renders the OpenDesign mockup case 28100 / 200000 → "28.1k / 200k"', () => {
    set(28_100, 200_000, 'claude-sonnet-4.6');
    const used = fixture.nativeElement.querySelector('.ds-token-meter__used')?.textContent?.trim();
    const limit = fixture.nativeElement.querySelector('.ds-token-meter__limit')?.textContent?.trim();
    const model = fixture.nativeElement.querySelector('.ds-token-meter__model')?.textContent?.trim();
    expect(used).toBe('28.1k');
    expect(limit).toBe('200k');
    expect(model).toBe('claude-sonnet-4.6');
  });

  it('hides the model label when modelLabel is null (Codex/etc. with no exposed model)', () => {
    set(100, 1000);
    expect(fixture.nativeElement.querySelector('.ds-token-meter__model')).toBeNull();
  });

  it('paints the bar with tone=normal under 80 %', () => {
    set(50_000, 200_000); // 25 %
    const fill = fixture.nativeElement.querySelector('.ds-token-meter__fill') as HTMLElement;
    expect(fill.getAttribute('data-tone')).toBe('normal');
    expect(fill.style.width).toBe('25%');
  });

  it('flips to tone=warning at 80 %', () => {
    set(160_000, 200_000); // 80 %
    const fill = fixture.nativeElement.querySelector('.ds-token-meter__fill') as HTMLElement;
    expect(fill.getAttribute('data-tone')).toBe('warning');
  });

  it('flips to tone=danger at 95 %', () => {
    set(190_000, 200_000); // 95 %
    const fill = fixture.nativeElement.querySelector('.ds-token-meter__fill') as HTMLElement;
    expect(fill.getAttribute('data-tone')).toBe('danger');
  });

  it('clamps the visual fill at 100 % when used exceeds limit (no overflow)', () => {
    set(250_000, 200_000); // 125 %
    const fill = fixture.nativeElement.querySelector('.ds-token-meter__fill') as HTMLElement;
    expect(fill.style.width).toBe('100%');
    expect(fill.getAttribute('data-tone')).toBe('danger');
  });

  it('treats limit ≤ 0 as a non-meter (no fill, tone=normal)', () => {
    set(100, 0);
    const fill = fixture.nativeElement.querySelector('.ds-token-meter__fill') as HTMLElement;
    expect(fill.style.width).toBe('0%');
    expect(fill.getAttribute('data-tone')).toBe('normal');
  });

  it('reflects used/limit on the ARIA progressbar so screen readers announce progress', () => {
    set(28_100, 200_000);
    const bar = fixture.nativeElement.querySelector('[role="progressbar"]') as HTMLElement;
    expect(bar.getAttribute('aria-valuemin')).toBe('0');
    expect(bar.getAttribute('aria-valuemax')).toBe('200000');
    expect(bar.getAttribute('aria-valuenow')).toBe('28100');
    expect(bar.getAttribute('aria-label')).toBe('statusbar.token_meter');
  });
});
