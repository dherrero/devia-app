import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import {
  RENDERER_ZOOM_DEFAULT,
  RENDERER_ZOOM_MAX,
  RENDERER_ZOOM_MIN,
  RENDERER_ZOOM_STORAGE_KEY,
  RendererZoomService,
  normalizeRendererZoom,
  resolveStoredRendererZoom,
} from './renderer-zoom.service';

describe('RendererZoomService', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.style.fontSize = '';
    TestBed.resetTestingModule();
  });

  afterEach(() => {
    localStorage.clear();
    document.documentElement.style.fontSize = '';
  });

  it('normalizes invalid and out-of-range zoom values', () => {
    expect(normalizeRendererZoom(Number.NaN)).toBe(RENDERER_ZOOM_DEFAULT);
    expect(normalizeRendererZoom(10)).toBe(RENDERER_ZOOM_MIN);
    expect(normalizeRendererZoom(999)).toBe(RENDERER_ZOOM_MAX);
    expect(normalizeRendererZoom(107)).toBe(110);
  });

  it('reads persisted zoom and falls back to default for invalid values', () => {
    localStorage.setItem(RENDERER_ZOOM_STORAGE_KEY, '120');
    expect(resolveStoredRendererZoom()).toBe(120);

    localStorage.setItem(RENDERER_ZOOM_STORAGE_KEY, 'wat');
    expect(resolveStoredRendererZoom()).toBe(RENDERER_ZOOM_DEFAULT);
  });

  it('applies and persists zoom changes', () => {
    const service = TestBed.inject(RendererZoomService);

    service.increase();
    expect(service.percent()).toBe(110);
    expect(service.label()).toBe('110%');
    expect(localStorage.getItem(RENDERER_ZOOM_STORAGE_KEY)).toBe('110');
    expect(document.documentElement.style.fontSize).toBe('110%');

    service.reset();
    expect(service.percent()).toBe(RENDERER_ZOOM_DEFAULT);
    expect(document.documentElement.style.fontSize).toBe('100%');
  });
});
