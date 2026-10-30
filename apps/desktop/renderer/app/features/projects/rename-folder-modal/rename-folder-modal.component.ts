import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ViewChild,
  computed,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ButtonComponent, DIALOG_DATA, DialogRef, IconComponent, InputComponent } from '@devia/ui';
import { TranslateModule } from '@ngx-translate/core';
import { LucidePencil, LucideX } from '@lucide/angular';
import { ElectronApiService } from '../../../core/services/electron-api.service';
import { AppStateService } from '../../../core/services/app-state.service';

export interface RenameFolderModalData {
  /** Path of the folder being renamed (relative to workspace root). */
  path: string;
  /** Current folder name, used to prefill the input. */
  currentName: string;
}

@Component({
  selector: 'ds-rename-folder-modal',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, FormsModule, IconComponent, InputComponent, TranslateModule],
  templateUrl: './rename-folder-modal.component.html',
  styleUrl: './rename-folder-modal.component.scss',
})
export class RenameFolderModalComponent implements AfterViewInit {
  @ViewChild('inputRef') private inputRef?: InputComponent;

  readonly data = inject<RenameFolderModalData>(DIALOG_DATA);
  private readonly state = inject(AppStateService);
  private readonly api = inject(ElectronApiService);
  readonly ref = inject(DialogRef, { optional: true });
  readonly LucidePencil = LucidePencil;
  readonly LucideX = LucideX;

  readonly name = signal(this.data.currentName);
  readonly renaming = signal(false);
  readonly errorMessage = signal<string | null>(null);
  readonly canRename = computed(() => {
    const next = this.name().trim();
    return !this.renaming() && next.length > 0 && next !== this.data.currentName.trim();
  });

  ngAfterViewInit(): void {
    setTimeout(() => {
      this.inputRef?.focus();
      this.inputRef?.select();
    }, 0);
  }

  onNameChange(value: string): void {
    this.name.set(value);
    if (this.errorMessage()) this.errorMessage.set(null);
  }

  cancel(): void {
    this.ref?.close(null);
  }

  async rename() {
    const next = this.name().trim();
    if (!next) {
      this.errorMessage.set('El nombre no puede estar vacio.');
      return;
    }
    if (next === this.data.currentName.trim()) {
      this.errorMessage.set('El nombre no ha cambiado.');
      return;
    }
    if (!this.canRename()) return;
    this.renaming.set(true);
    this.errorMessage.set(null);
    try {
      const newPath = await this.api.renameFolder(this.data.path, next);
      // Keep the user inside the renamed folder if they were navigated there
      // (or anywhere underneath), so the breadcrumb doesn't dangle on a stale
      // prefix once the rename takes effect.
      const nav = this.state.navPath();
      if (nav === this.data.path) {
        this.state.navPath.set(newPath);
      } else if (nav.startsWith(this.data.path + '/')) {
        this.state.navPath.set(newPath + nav.slice(this.data.path.length));
      }
      await this.state.reloadProjects();
      this.ref?.close(newPath);
    } catch (err) {
      console.error('[rename-folder] renameFolder failed:', err);
      this.errorMessage.set(humanizeIpcError(err));
    } finally {
      this.renaming.set(false);
    }
  }
}

// Strips Electron's "Error invoking remote method 'channel':" prefix so the
// localized message thrown by the use case is shown verbatim.
function humanizeIpcError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '');
}
