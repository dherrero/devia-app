import { SecurityContext } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { DomSanitizer } from '@angular/platform-browser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarkdownRendererService } from './markdown-renderer.service';

type MarkdownTestGlobal = typeof globalThis & {
  marked?: { parse: ReturnType<typeof vi.fn> };
  DOMPurify?: { sanitize: ReturnType<typeof vi.fn> };
  requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
};

describe('MarkdownRendererService', () => {
  let service: MarkdownRendererService;
  let sanitizer: DomSanitizer;
  const globals = globalThis as MarkdownTestGlobal;

  beforeEach(() => {
    globals.marked = { parse: vi.fn((text: string) => `<p>${text}</p>`) };
    globals.DOMPurify = { sanitize: vi.fn((html: string) => html.replace('unsafe', 'safe')) };

    TestBed.configureTestingModule({});
    service = TestBed.inject(MarkdownRendererService);
    sanitizer = TestBed.inject(DomSanitizer);
  });

  afterEach(() => {
    delete globals.marked;
    delete globals.DOMPurify;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('returns cached html for the same key and text', () => {
    const first = service.render('m1:block:0', 'hello');
    const second = service.render('m1:block:0', 'hello');

    expect(globals.marked?.parse).toHaveBeenCalledTimes(1);
    expect(sanitizer.sanitize(SecurityContext.HTML, first.html)).toBe('<p>hello</p>');
    expect(sanitizer.sanitize(SecurityContext.HTML, second.html)).toBe('<p>hello</p>');
  });

  it('re-renders when the cached text changes', () => {
    service.render('m1:block:0', 'hello');
    const second = service.render('m1:block:0', 'changed');

    expect(globals.marked?.parse).toHaveBeenCalledTimes(2);
    expect(sanitizer.sanitize(SecurityContext.HTML, second.html)).toBe('<p>changed</p>');
  });

  it('coalesces prewarm calls and renders only the latest text', () => {
    vi.useFakeTimers();

    service.prewarm('m1:block:0', 'first');
    service.prewarm('m1:block:0', 'second');
    vi.runAllTimers();

    expect(globals.marked?.parse).toHaveBeenCalledTimes(1);
    expect(globals.marked?.parse).toHaveBeenCalledWith('second');
  });

  it('decorates valid language-json code blocks before sanitizing', () => {
    globals.marked = {
      parse: vi.fn(
        () => '<pre><code class="language-json">{"name":"devia","enabled":true,"count":3,"items":null}</code></pre>',
      ),
    };

    const result = service.render('m1:block:0', 'json');
    const html = sanitizer.sanitize(SecurityContext.HTML, result.html) ?? '';

    expect(result.plainTextFallback).toBe(false);
    expect(html).toContain('class="json-code-block"');
    expect(html).toContain('class="language-json json-code"');
    expect(html).toContain('class="json-token json-key"');
    expect(html).toContain('class="json-token json-string"');
    expect(html).toContain('class="json-token json-boolean"');
    expect(html).toContain('class="json-token json-number"');
    expect(html).toContain('class="json-token json-null"');
    expect(globals.DOMPurify?.sanitize).toHaveBeenCalledWith(expect.stringContaining('json-token json-key'));
  });

  it('adds a copy button after the code of every fenced block', () => {
    globals.marked = {
      parse: vi.fn(() => '<pre><code>npm install</code></pre><pre><code class="language-sh">ls</code></pre>'),
    };

    const result = service.render('m1:block:0', 'code');
    const html = sanitizer.sanitize(SecurityContext.HTML, result.html) ?? '';

    expect(html.match(/<button type="button" class="code-copy-btn"/g)).toHaveLength(2);
    expect(html).toContain('<code>npm install</code><button');
  });

  it('falls back to plain text when globals are unavailable', () => {
    delete globals.marked;
    delete globals.DOMPurify;

    const result = service.render('m1:block:0', 'hello');

    expect(result.plainTextFallback).toBe(true);
    expect(sanitizer.sanitize(SecurityContext.HTML, result.html)).toBe('');
  });
});
