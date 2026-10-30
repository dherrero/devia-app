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
import { ButtonComponent, DialogRef, IconComponent, InputComponent } from '@devia/ui';
import { TranslateModule } from '@ngx-translate/core';
import { LucideFolderPlus, LucideX } from '@lucide/angular';
import { ElectronApiService } from '../../../core/services/electron-api.service';
import { AppStateService } from '../../../core/services/app-state.service';

@Component({
  selector: 'ds-new-folder-modal',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, FormsModule, IconComponent, InputComponent, TranslateModule],
  templateUrl: './new-folder-modal.component.html',
  styleUrl: './new-folder-modal.component.scss',
})
export class NewFolderModalComponent implements AfterViewInit {
  @ViewChild('inputRef') private inputRef?: InputComponent;

  readonly state = inject(AppStateService);
  private readonly api = inject(ElectronApiService);
  readonly ref = inject(DialogRef, { optional: true });
  readonly LucideFolderPlus = LucideFolderPlus;
  readonly LucideX = LucideX;

  readonly name = signal('');
  readonly creating = signal(false);
  readonly errorMessage = signal<string | null>(null);
  readonly canCreate = computed(() => this.name().trim().length > 0 && !this.creating());

  ngAfterViewInit(): void {
    setTimeout(() => this.inputRef?.focus(), 0);
  }

  onNameChange(value: string): void {
    this.name.set(value);
    if (this.errorMessage()) this.errorMessage.set(null);
  }

  cancel(): void {
    this.ref?.close(null);
  }

  async create() {
    const value = this.name().trim();
    if (!value) {
      this.errorMessage.set('El nombre no puede estar vacio.');
      return;
    }
    this.creating.set(true);
    this.errorMessage.set(null);
    try {
      const fullPath = await this.api.newFolder(value, this.state.navPath());
      await this.state.reloadProjects();
      this.ref?.close(fullPath);
    } catch (err) {
      // Electron wraps any throw from an ipcMain.handle() callback as
      // `Error invoking remote method 'X': Error: <real message>` before it
      // reaches the renderer. The technical prefix isn't useful to the user
      // (it leaks the IPC channel name and is English-only), so we strip it
      // for display and keep the full error in the console for debugging.
      console.error('[new-folder] newFolder failed:', err);
      this.errorMessage.set(humanizeIpcError(err));
    } finally {
      this.creating.set(false);
    }
  }
}

// Strips Electron's "Error invoking remote method 'channel':" prefix so the
// localized message thrown by the use case is shown verbatim.
function humanizeIpcError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '');
}
