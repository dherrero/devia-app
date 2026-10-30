import { Injectable, OnDestroy, inject } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';

type MarkdownGlobal = {
  marked?: { parse(text: string): string };
  DOMPurify?: { sanitize(html: string): string };
  requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
};

export interface RenderedMarkdown {
  html: SafeHtml;
  plainTextFallback: boolean;
}

interface CachedMarkdown extends RenderedMarkdown {
  text: string;
}

interface PendingRender {
  text: string;
  cancel: () => void;
}

@Injectable({ providedIn: 'root' })
export class MarkdownRendererService implements OnDestroy {
  private static readonly MAX_CACHE_ENTRIES = 300;

  private readonly sanitizer = inject(DomSanitizer);
  private readonly cache = new Map<string, CachedMarkdown>();
  private readonly pending = new Map<string, PendingRender>();
  private dompurifyErrorLogged = false;

  render(key: string, text: string): RenderedMarkdown {
    this.cancelPending(key);

    const cached = this.cache.get(key);
    if (cached?.text === text) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached;
    }

    const rendered = this.renderFresh(text);
    this.cache.set(key, { text, ...rendered });
    this.pruneCache();
    return rendered;
  }

  prewarm(key: string, text: string): void {
    const cached = this.cache.get(key);
    if (cached?.text === text) return;

    const pending = this.pending.get(key);
    if (pending?.text === text) return;

    this.cancelPending(key);

    const globals = globalThis as typeof globalThis & MarkdownGlobal;
    const run = () => {
      this.pending.delete(key);
      this.render(key, text);
    };

    if (typeof globals.requestIdleCallback === 'function') {
      const handle = globals.requestIdleCallback(run, { timeout: 500 });
      this.pending.set(key, {
        text,
        cancel: () => globals.cancelIdleCallback?.(handle),
      });
      return;
    }

    const handle = setTimeout(run, 0);
    this.pending.set(key, {
      text,
      cancel: () => clearTimeout(handle),
    });
  }

  ngOnDestroy(): void {
    for (const pending of this.pending.values()) pending.cancel();
    this.pending.clear();
  }

  private renderFresh(text: string): RenderedMarkdown {
    const globals = globalThis as typeof globalThis & MarkdownGlobal;
    if (!globals.marked || !globals.DOMPurify) {
      return this.plainText();
    }

    try {
      const html = globals.marked.parse(text);
      const safe = globals.DOMPurify.sanitize(this.decorateJsonCodeBlocks(html));
      return {
        html: this.sanitizer.bypassSecurityTrustHtml(safe),
        plainTextFallback: false,
      };
    } catch (err) {
      if (!this.dompurifyErrorLogged) {
        this.dompurifyErrorLogged = true;
        console.error('[message-bubble] markdown render failed - falling back to plain text:', err);
      }
      return this.plainText();
    }
  }

  private plainText(): RenderedMarkdown {
    return {
      html: this.sanitizer.bypassSecurityTrustHtml(''),
      plainTextFallback: true,
    };
  }

  private cancelPending(key: string): void {
    const pending = this.pending.get(key);
    if (!pending) return;
    pending.cancel();
    this.pending.delete(key);
  }

  private pruneCache(): void {
    while (this.cache.size > MarkdownRendererService.MAX_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) return;
      this.cache.delete(oldest);
    }
  }

  private decorateJsonCodeBlocks(html: string): string {
    const doc = globalThis.document;
    if (!doc) return html;

    const template = doc.createElement('template');
    template.innerHTML = html;

    const blocks = template.content.querySelectorAll('pre > code.language-json');
    for (const code of blocks) {
      const raw = code.textContent ?? '';
      try {
        JSON.parse(raw);
      } catch {
        continue;
      }

      code.textContent = '';
      code.classList.add('json-code');
      code.parentElement?.classList.add('json-code-block');
      this.appendJsonTokens(doc, code, raw);
    }

    return template.innerHTML;
  }

  private appendJsonTokens(doc: Document, parent: Element, source: string): void {
    const tokenPattern =
      /"(?:\\u[\dA-Fa-f]{4}|\\[^u]|[^\\"])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}[\],:]/g;
    let index = 0;

    for (const match of source.matchAll(tokenPattern)) {
      const token = match[0];
      const start = match.index ?? 0;
      if (start > index) parent.append(source.slice(index, start));

      const next = source.slice(start + token.length);
      const kind = this.jsonTokenKind(token, /^\s*:/.test(next));
      this.appendToken(doc, parent, kind, token);
      index = start + token.length;
    }

    if (index < source.length) parent.append(source.slice(index));
  }

  private jsonTokenKind(token: string, followedByColon: boolean): string {
    if (token.startsWith('"')) return followedByColon ? 'key' : 'string';
    if (token === 'true' || token === 'false') return 'boolean';
    if (token === 'null') return 'null';
    if (/^-?\d/.test(token)) return 'number';
    return 'punctuation';
  }

  private appendToken(doc: Document, parent: Element, kind: string, text: string): void {
    const span = doc.createElement('span');
    span.className = `json-token json-${kind}`;
    span.textContent = text;
    parent.append(span);
  }
}
