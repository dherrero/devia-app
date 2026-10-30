import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TestBed, ComponentFixture } from '@angular/core/testing';
import { SearchBoxComponent } from './search-box.component';

describe('SearchBoxComponent (HT-SB-03)', () => {
  let fixture: ComponentFixture<SearchBoxComponent>;

  beforeEach(async () => {
    vi.useFakeTimers();
    await TestBed.configureTestingModule({
      imports: [SearchBoxComponent],
    }).compileComponents();
    fixture = TestBed.createComponent(SearchBoxComponent);
    fixture.detectChanges();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function input(): HTMLInputElement {
    return (fixture.nativeElement as HTMLElement).querySelector(
      '.ds-search-box__input',
    ) as HTMLInputElement;
  }

  function typeValue(v: string): void {
    fixture.componentInstance.value.set(v);
    (fixture.componentInstance as unknown as { onInput: () => void }).onInput();
  }

  it('renders the search icon when the value is empty', () => {
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('.ds-search-box__hint'),
    ).not.toBeNull();
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('dv-button'),
    ).toBeNull();
  });

  it('replaces the hint with a clear button when the value has content', () => {
    fixture.componentRef.setInput('placeholder', 'Search');
    fixture.componentInstance.value.set('hello');
    fixture.detectChanges();
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('dv-button'),
    ).not.toBeNull();
  });

  it('uses the placeholder input on the underlying input', () => {
    fixture.componentRef.setInput('placeholder', 'Buscar proyectos…');
    fixture.detectChanges();
    expect(input().placeholder).toBe('Buscar proyectos…');
  });

  it('debounces queryChange by 180 ms by default', () => {
    let last: string | null = null;
    fixture.componentInstance.queryChange.subscribe((q) => (last = q));
    typeValue('a');
    typeValue('ab');
    typeValue('abc');
    vi.advanceTimersByTime(80);
    expect(last).toBeNull();
    vi.advanceTimersByTime(120);
    expect(last).toBe('abc');
  });

  it('only emits once when the same value lands consecutively', () => {
    const events: string[] = [];
    fixture.componentInstance.queryChange.subscribe((q) => events.push(q));
    typeValue('abc');
    vi.advanceTimersByTime(200);
    typeValue('abc');
    vi.advanceTimersByTime(200);
    expect(events).toEqual(['abc']);
  });

  it('emits the empty string immediately when the user clears the input by hand', () => {
    let last: string | null = null;
    fixture.componentInstance.queryChange.subscribe((q) => (last = q));
    typeValue('something');
    vi.advanceTimersByTime(200);
    expect(last).toBe('something');
    typeValue('');
    expect(last).toBe('');
  });

  it('respects a custom debounce window', () => {
    fixture.componentRef.setInput('debounceMs', 50);
    fixture.detectChanges();
    let last: string | null = null;
    fixture.componentInstance.queryChange.subscribe((q) => (last = q));
    typeValue('q');
    vi.advanceTimersByTime(60);
    expect(last).toBe('q');
  });

  it('clear button resets the value, fires queryChange("") and the cleared output', () => {
    const emissions: string[] = [];
    let clearedCount = 0;
    fixture.componentInstance.queryChange.subscribe((q) => emissions.push(q));
    fixture.componentInstance.cleared.subscribe(() => (clearedCount += 1));

    typeValue('hello');
    vi.advanceTimersByTime(200);
    expect(emissions).toEqual(['hello']);

    fixture.detectChanges();
    const clearBtn = (fixture.nativeElement as HTMLElement).querySelector(
      'dv-button button',
    ) as HTMLButtonElement;
    clearBtn.click();
    expect(fixture.componentInstance.value()).toBe('');
    expect(emissions).toEqual(['hello', '']);
    expect(clearedCount).toBe(1);
  });
});
