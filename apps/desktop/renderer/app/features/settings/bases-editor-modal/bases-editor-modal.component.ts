import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ButtonComponent, CodeTextareaComponent, DialogRef, IconComponent } from '@devia/ui';
import { LucideX } from '@lucide/angular';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { ElectronApiService } from '../../../core/services/electron-api.service';
import { ToastService } from '../../../core/services/toast.service';

@Component({
  selector: 'ds-bases-editor-modal',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, CodeTextareaComponent, FormsModule, IconComponent, TranslateModule],
  host: {
    '(window:keydown)': 'onWindowKeydown($event)',
  },
  templateUrl: './bases-editor-modal.component.html',
  styleUrl: './bases-editor-modal.component.scss',
})
export class BasesEditorModalComponent implements OnInit {
  readonly LucideX = LucideX;
  private readonly api = inject(ElectronApiService);
  private readonly toast = inject(ToastService);
  readonly ref = inject(DialogRef, { optional: true });
  private readonly translate = inject(TranslateService);

  readonly filePath = signal('');
  readonly text = signal('');
  readonly loading = signal(true);
  readonly saving = signal(false);

  // Re-validates on every keystroke (textarea two-way binding writes to
  // `text` which is a signal). The parse error doubles as the save guard.
  readonly parseError = computed<string | null>(() => {
    const t = this.text();
    if (!t.trim()) return this.translate.instant('modals.bases_editor.error_empty');
    try {
      const parsed: unknown = JSON.parse(t);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return this.translate.instant('modals.bases_editor.error_not_object');
      }
      return null;
    } catch (err) {
      return (err as Error).message;
    }
  });

  readonly entryCount = computed(() => {
    if (this.parseError()) return 0;
    try {
      return Object.keys(JSON.parse(this.text()) as Record<string, unknown>).length;
    } catch {
      return 0;
    }
  });

  readonly isEmpty = computed(() => !this.text().trim() || (!this.parseError() && this.entryCount() === 0));
  readonly isValid = computed(() => !this.parseError() && this.entryCount() > 0);
  readonly isInvalid = computed(() => !!this.parseError() && !this.isEmpty());

  readonly canSave = computed(() => !this.saving() && !this.parseError() && this.entryCount() > 0);

  async ngOnInit() {
    try {
      const { text, filePath } = await this.api.readBasesJson();
      this.text.set(text);
      this.filePath.set(filePath);
    } catch (err) {
      this.toast.show(
        this.translate.instant('modals.bases_editor.toast_read_error', { error: (err as Error).message }),
        { kind: 'error' },
      );
    } finally {
      this.loading.set(false);
    }
  }

  // Capture Tab so the textarea stays usable for indenting JSON instead of
  // jumping focus out of the dialog.
  onTab(e: KeyboardEvent): void {
    if (this.saving() || e.shiftKey) return;
    e.preventDefault();
    const target = e.target as HTMLTextAreaElement;
    const start = target.selectionStart;
    const end = target.selectionEnd;
    const before = target.value.substring(0, start);
    const after = target.value.substring(end);
    target.value = before + '  ' + after;
    target.selectionStart = target.selectionEnd = start + 2;
    this.text.set(target.value);
  }

  onWindowKeydown(e: KeyboardEvent): void {
    if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 's') return;
    e.preventDefault();
    void this.save();
  }

  cancel(): void {
    this.ref?.close(false);
  }

  async save() {
    if (!this.canSave()) return;
    this.saving.set(true);
    try {
      const result = await this.api.writeBasesJson(this.text());
      this.toast.show(
        this.translate.instant('modals.bases_editor.toast_success', { count: result.count, plural: result.count === 1 ? '' : 's' }),
        { kind: 'success' },
      );
      this.ref?.close(true);
    } catch (err) {
      this.toast.show(
        this.translate.instant('modals.bases_editor.toast_write_error', { error: (err as Error).message }),
        { kind: 'error' },
      );
    } finally {
      this.saving.set(false);
    }
  }
}
