import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { ButtonComponent, DIALOG_DATA, DialogRef, IconComponent } from '@devia/ui';
import { LucideFileText } from '@lucide/angular';
import { TranslateModule } from '@ngx-translate/core';

/**
 * Generic Markdown dialog viewer (#269).
 *
 * Reuses the same `marked` + DOMPurify pipeline message-bubble uses
 * — those globals are already loaded as `scripts` in `angular.json`
 * so there's no extra runtime cost. Output is sanitised before being
 * assigned to `innerHTML`.
 *
 * Originally lived under the spec-kit feature; promoted here when
 * spec-kit was removed (E-DSK-12 T1) since the skill-registry badge
 * is the sole remaining consumer.
 */

export interface RegistryViewerData {
  readonly title: string;
  readonly body: string;
  readonly relativePath: string;
}

// `marked` and `DOMPurify` are loaded via `angular.json#scripts` and
// expose themselves on `window`. Declare here so TS recognises them.
declare const marked: { parse: (md: string) => string };
declare const DOMPurify: { sanitize: (html: string) => string } | undefined;

@Component({
  selector: 'ds-registry-viewer',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, IconComponent, TranslateModule],
  templateUrl: './registry-viewer.component.html',
  styleUrl: './registry-viewer.component.scss',
})
export class RegistryViewerComponent {
  readonly LucideFileText = LucideFileText;
  readonly data = inject<RegistryViewerData>(DIALOG_DATA);
  readonly ref = inject(DialogRef, { optional: true });

  readonly html = computed(() => {
    try {
      const raw = typeof marked !== 'undefined' ? marked.parse(this.data.body) : this.data.body;
      // DOMPurify may not be loaded in non-browser test envs — fall
      // back to the raw HTML and trust the input's provenance (it
      // came from the local filesystem inside the user's project).
      if (typeof DOMPurify !== 'undefined') return DOMPurify.sanitize(raw);
      return raw;
    } catch {
      return `<pre>${escapeHtml(this.data.body)}</pre>`;
    }
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
