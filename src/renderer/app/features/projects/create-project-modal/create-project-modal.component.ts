import {
  ChangeDetectionStrategy, Component, computed, effect, inject, signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import {
  LucideRocket, LucidePlusCircle, LucideStar, LucideDownload, LucideX,
} from '@lucide/angular';
import {
  ButtonComponent,
  DialogRef,
  IconComponent,
  InputComponent,
  OptionCardComponent,
  SelectComponent,
  TextareaComponent,
  type SelectOption,
} from '@devia/ui';

import { ElectronApiService } from '../../../core/services/electron-api.service';
import { AppStateService } from '../../../core/services/app-state.service';
import { KanbanStateService } from '../../kanban/services/kanban-state.service';

type CreateType = 'blank' | 'base' | 'import';
const NAME_RE = /^[a-zA-Z0-9._-]+$/;

/**
 * Unified "Nuevo proyecto en Devia" modal.
 *
 * Replaces the old chain (name modal → bootstrap nuevo/existente modal),
 * which redundantly asked new/existing right after creating an empty
 * project. The user picks the creation TYPE up front (blank / base /
 * import) and then either:
 *   - "Crear": create only (no kanban). The project is marked
 *     bootstrap-handled so the first-contact auto-modal won't fire.
 *   - "Empieza la magia…": create + start the SDD flow — init (blank /
 *     base, seeded from the intent) or prepare (import, an existing repo).
 *
 * Bases editing lives in the header settings menu now, not here.
 */
@Component({
  selector: 'ds-create-project-modal',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    ButtonComponent,
    IconComponent,
    InputComponent,
    OptionCardComponent,
    SelectComponent,
    TextareaComponent,
    TranslateModule,
  ],
  templateUrl: './create-project-modal.component.html',
  styleUrl: './create-project-modal.component.scss',
})
export class CreateProjectModalComponent {
  readonly LucideRocket = LucideRocket;
  readonly LucidePlusCircle = LucidePlusCircle;
  readonly LucideStar = LucideStar;
  readonly LucideDownload = LucideDownload;
  readonly LucideX = LucideX;

  readonly state = inject(AppStateService);
  private readonly api = inject(ElectronApiService);
  private readonly kanban = inject(KanbanStateService);
  readonly ref = inject(DialogRef, { optional: true });
  private readonly translate = inject(TranslateService);

  readonly type = signal<CreateType>('blank');
  readonly bases = signal<string[]>([]);
  readonly baseOptions = computed<SelectOption[]>(() =>
    this.bases().map((base) => ({ value: base, label: base })),
  );
  readonly name = signal('');
  readonly repoUrl = signal('');
  readonly base = signal('');
  readonly intent = signal('');
  readonly busy = signal(false);
  readonly output = signal<string[]>([]);
  readonly errorMessage = signal<string | null>(null);
  readonly outputText = computed(() => this.output().join('\n'));

  private userEditedName = false;
  private baseAutoSetup = '';
  private cloneResolve: ((path: string | null) => void) | null = null;

  readonly nameInvalid = computed(() => {
    const v = this.name().trim();
    return v.length > 0 && !NAME_RE.test(v);
  });
  readonly canCreate = computed(() => {
    const n = this.name().trim();
    if (!n || !NAME_RE.test(n)) return false;
    if (this.type() === 'base' && !this.base()) return false;
    if (this.type() === 'import' && !this.repoUrl().trim()) return false;
    return true;
  });
  // "Empieza la magia" additionally needs an intent for new (blank/base);
  // import doesn't — prepare analyses the repo regardless.
  readonly canMagic = computed(() =>
    this.canCreate() && (this.type() === 'import' || this.intent().trim().length > 0),
  );

  constructor() {
    void this.loadBases();
    this.api.onCloneOutput((e) => {
      const next = [...this.output(), e.line];
      this.output.set(next.length > 400 ? next.slice(-400) : next);
    });
    this.api.onCloneEnd((e) => {
      if (e.code === 0 && e.fullPath) {
        this.cloneResolve?.(e.fullPath);
      } else {
        this.errorMessage.set(e.error ?? this.translate.instant('modals.create_project.error'));
        this.cloneResolve?.(null);
      }
      this.cloneResolve = null;
    });
    // Block dialog dismissal while a clone is mid-flight.
    effect(() => { if (this.ref) this.ref.disableClose = this.busy(); });
  }

  private async loadBases(): Promise<void> {
    try {
      const list = await this.api.listBases();
      this.bases.set(list);
      if (list.length > 0 && !this.base()) this.base.set(list[0] ?? '');
    } catch {
      this.bases.set([]);
    }
  }

  selectType(next: CreateType): void {
    if (this.busy()) return;
    this.type.set(next);
    this.errorMessage.set(null);
  }

  onNameChange(value: string): void {
    this.userEditedName = true;
    this.name.set(value);
  }

  onUrlChange(value: string): void {
    this.repoUrl.set(value);
    if (this.userEditedName) return;
    const m = value.trim().match(/\/([^/]+?)(?:\.git)?\/?$/);
    if (m?.[1]) this.name.set(m[1]);
  }

  /** Crear (magic=false) or Empieza la magia (magic=true). */
  async run(magic: boolean): Promise<void> {
    if (magic ? !this.canMagic() : !this.canCreate()) return;
    this.busy.set(true);
    this.errorMessage.set(null);
    try {
      const path = await this.createProject();
      if (!path) { this.busy.set(false); return; } // failed (e.g. clone) — keep open
      await this.state.reloadProjects();

      if (magic) {
        this.state.selectProject(path);
        await this.startKanban(path);
      } else {
        // Mark handled BEFORE selecting so the auto-bootstrap modal sees the
        // marker and stays closed.
        await this.api.sddMarkHandled(path, this.type() === 'import' ? 'existing' : 'new');
        this.state.selectProject(path);
      }
      this.ref?.close(path);
    } catch {
      this.errorMessage.set(this.translate.instant('modals.create_project.error'));
      this.busy.set(false);
    }
  }

  private createProject(): Promise<string | null> {
    const name = this.name().trim();
    const parent = this.state.navPath();
    if (this.type() === 'blank') {
      return this.api.newProject(name, parent);
    }
    if (this.type() === 'base') {
      return this.api.newFromBase(this.base(), name, parent).then((r) => {
        this.baseAutoSetup = r.autoSetup ?? '';
        return r.projectPath;
      });
    }
    // import → clone (async via clone:* events)
    this.output.set([]);
    return new Promise<string | null>((resolve) => {
      this.cloneResolve = resolve;
      this.api.cloneRepo({
        repositoryUrl: this.repoUrl().trim(),
        projectName: name,
        parentPath: parent,
      });
    });
  }

  private async startKanban(path: string): Promise<void> {
    const intent = this.intent().trim();
    if (this.type() === 'import') {
      await this.kanban.startSddPlanning(path, 'existing', intent);
    } else {
      const seed = intent || this.baseAutoSetup;
      await this.kanban.startSddPlanning(path, 'new', seed, intent);
    }
  }
}
