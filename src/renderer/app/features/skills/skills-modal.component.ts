import {
  ChangeDetectionStrategy, Component, OnDestroy, computed, inject, signal,
} from '@angular/core';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { LucidePuzzle, LucidePackage, LucidePlusCircle } from '@lucide/angular';
import { firstValueFrom } from 'rxjs';
import {
  ButtonComponent,
  DialogRef,
  DialogService,
  DIALOG_DATA,
  SpinnerComponent,
} from '@devia/ui';
import { ElectronApiService } from '../../core/services/electron-api.service';
import { ToastService } from '../../core/services/toast.service';
import { ProjectAssetsService } from '../../core/services/project-assets.service';
import { ModalShellComponent, type ModalNavSection } from '../../shared/components/modal-shell/modal-shell.component';
import { SkillsInstalledTabComponent } from './components/skills-installed-tab/skills-installed-tab.component';
import { SkillsInstallFormComponent } from './components/skills-install-form/skills-install-form.component';
import { SkillsPickStageComponent } from './components/skills-pick-stage/skills-pick-stage.component';
import type {
  DiscoveredSkill, InstalledSkill, SkillAgent, SkillScope,
} from '../../../types/devia';

interface SkillsModalData {
  project: string;
}

/**
 * Two-step install:
 *
 *   form     – user types source/agents/scope. If they leave the "specific
 *              skill" filter empty, clicking Install transitions to `pick`
 *              after a discovery (shallow clone + scan of SKILL.md). If
 *              they typed a filter, we install that single skill directly.
 *   pick     – multi-select checkboxes of every skill found in the temp
 *              clone. Confirm installs the selected ones; cancel/close
 *              frees the temp dir.
 */
type InstallStage = 'form' | 'pick';

@Component({
  selector: 'ds-skills-modal',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ButtonComponent, SpinnerComponent,
    TranslateModule, ModalShellComponent,
    SkillsInstalledTabComponent, SkillsInstallFormComponent, SkillsPickStageComponent,
  ],
  templateUrl: './skills-modal.component.html',
  styleUrl: './skills-modal.component.scss',
})
export class SkillsModalComponent implements OnDestroy {
  readonly LucidePuzzle = LucidePuzzle;

  readonly data = inject<SkillsModalData>(DIALOG_DATA, { optional: true }) as SkillsModalData;
  private readonly api = inject(ElectronApiService);
  readonly dialogRef = inject(DialogRef, { optional: true });
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);
  private readonly dialogs = inject(DialogService);
  private readonly assets = inject(ProjectAssetsService);

  readonly loading = signal(false);
  readonly installing = signal(false);
  readonly discovering = signal(false);
  readonly removingId = signal<string | null>(null);

  readonly projectSkills = signal<InstalledSkill[]>([]);
  readonly globalSkills = signal<InstalledSkill[]>([]);

  /** Live filter for the discovery picker. */
  readonly discoverQuery = signal('');

  readonly stage = signal<InstallStage>('form');
  /** Active left-rail section. Drives the footer button set. */
  readonly active = signal<string>('installed');
  readonly sections = computed<ModalNavSection[]>(() => [
    { id: 'installed', label: this.translate.instant('modals.skills.tab_installed'), icon: LucidePackage },
    { id: 'install', label: this.translate.instant('modals.skills.tab_install'), icon: LucidePlusCircle },
  ]);

  // -- Install form state ----------------------------------------------
  readonly installSource = signal('');
  readonly installSkillName = signal('');
  readonly installScope = signal<SkillScope>('project');
  readonly selectedAgents = signal<SkillAgent[]>([]);

  // -- Discovery state -------------------------------------------------
  readonly discoveredSkills = signal<DiscoveredSkill[]>([]);
  readonly selectedDiscovered = signal<Set<string>>(new Set<string>());
  readonly committedSource = signal('');
  private discoveryId: string | null = null;

  // -- Output / errors -------------------------------------------------
  readonly log = signal<string[]>([]);
  readonly errorMessage = signal<string | null>(null);

  readonly busy = computed(() =>
    this.loading() || this.installing() || this.discovering() || this.removingId() !== null,
  );

  /** True when the primary button on the form should run discovery first
   *  (no specific skill filter typed). */
  readonly willDiscover = computed(() => this.installSkillName().trim().length === 0);

  readonly canPrimary = computed(() =>
    !this.busy()
    && this.installSource().trim().length > 0
    && this.selectedAgents().length > 0,
  );

  readonly selectedDiscoveredCount = computed(() => this.selectedDiscovered().size);
  readonly canInstallSelection = computed(() =>
    !this.installing()
    && this.selectedDiscoveredCount() > 0
    && this.selectedAgents().length > 0,
  );

  constructor() {
    this.refresh();
  }

  ngOnDestroy(): void {
    // Wipe the temp clone on dialog close. The main process also clears
    // any leftovers on app quit, so this is just the hot path.
    if (this.discoveryId) {
      void this.api.cancelSkillDiscovery(this.discoveryId);
      this.discoveryId = null;
    }
  }

  /**
   * #270: revert the just-completed install by restoring its
   * captured snapshot. Drift (user-modified files since capture)
   * is reported with a warning toast; clean restores produce a
   * success toast and refresh the list.
   */
  private async undoInstall(snapshotId: string): Promise<void> {
    try {
      const result = await this.api.snapshotRestore('skills', snapshotId);
      if (result.failed.length > 0) {
        this.toast.show(
          this.translate.instant('modals.skills.undo_partial_error'),
          { kind: 'warning', durationMs: 8_000 },
        );
      } else if (result.drift.length > 0) {
        // Drift on skill paths shouldn't happen often (they're newly
        // created symlinks), but if a user touched them between install
        // and undo, surface it.
        this.toast.show(
          this.translate.instant('modals.skills.undo_drift'),
          { kind: 'warning', durationMs: 8_000 },
        );
      } else {
        this.toast.show(
          this.translate.instant('modals.skills.undo_ok'),
          { kind: 'success' },
        );
      }
      await this.refresh();
    } catch (err) {
      console.error('[skills] undo failed:', err);
      this.toast.show(
        err instanceof Error ? err.message : String(err),
        { kind: 'error' },
      );
    }
  }

  async refresh() {
    this.loading.set(true);
    try {
      const result = await this.api.listSkills(this.data.project);
      this.projectSkills.set(result.project);
      this.globalSkills.set(result.global);
      // Keep the right-rail Skills badge in sync (no skills change event).
      void this.assets.refreshSkills(this.data.project);
      // #269: piggy-back the registry refresh on the user's explicit
      // "actualizar" click so the .devia/skill-registry.md never lags
      // behind the list the user is staring at. Failures here are
      // silent — the registry is best-effort and the user shouldn't
      // see a list error toast for an unrelated background write.
      void this.api.skillRegistryRefresh(this.data.project);
    } catch (err) {
      console.error('[skills] list failed:', err);
      this.toast.show(
        this.translate.instant('modals.skills.list_error'),
        { kind: 'error' },
      );
    } finally {
      this.loading.set(false);
    }
  }

  // -- Primary action on the form --------------------------------------
  async onPrimaryAction() {
    if (!this.canPrimary()) return;
    if (this.willDiscover()) {
      await this.runDiscovery();
    } else {
      // User specified a single skill explicitly — install it directly
      // without the picker.
      await this.runInstall([this.installSkillName().trim()]);
    }
  }

  private async runDiscovery() {
    this.discovering.set(true);
    this.errorMessage.set(null);
    this.log.set([]);
    try {
      const result = await this.api.discoverSkills({ source: this.installSource().trim() });
      if (!result.ok || !result.discoveryId) {
        this.errorMessage.set(result.error ?? this.translate.instant('modals.skills.discover_error'));
        return;
      }
      this.discoveryId = result.discoveryId;
      this.committedSource.set(this.installSource().trim());
      this.discoveredSkills.set(result.skills);
      // Pre-select everything — the most common case is "install the lot"
      // and the user can deselect what they don't want with two clicks.
      this.selectedDiscovered.set(new Set(result.skills.map((s) => s.name)));
      this.discoverQuery.set('');
      this.stage.set('pick');
    } catch (err) {
      this.errorMessage.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.discovering.set(false);
    }
  }

  private async runInstall(skillNames: string[]) {
    this.installing.set(true);
    this.errorMessage.set(null);
    this.log.set([]);
    try {
      const result = await this.api.installSkills({
        project: this.data.project,
        source: this.committedSource() || this.installSource().trim(),
        skillNames,
        agents: this.selectedAgents(),
        scope: this.installScope(),
        ...(this.discoveryId ? { discoveryId: this.discoveryId } : {}),
      });
      this.log.set(result.output);
      // The runner releases the temp dir as part of install (success or
      // failure) so we clear our handle either way.
      this.discoveryId = null;

      if (result.ok) {
        // #270: when the installer captured a snapshot we wire it into
        // the toast click — clicking "Deshacer" restores the snapshot,
        // which unlinks the just-created skill symlinks/junctions.
        const snapId = result.snapshotId;
        this.toast.show(
          snapId
            ? this.translate.instant('modals.skills.install_ok_undo')
            : this.translate.instant('modals.skills.install_ok'),
          {
            kind: 'success',
            durationMs: snapId ? 8_000 : 5_000,
            ...(snapId ? { onClick: () => void this.undoInstall(snapId) } : {}),
          },
        );
        this.resetInstallForm();
        await this.refresh();
      } else {
        this.errorMessage.set(result.error ?? this.translate.instant('modals.skills.install_error'));
      }
    } catch (err) {
      this.errorMessage.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.installing.set(false);
    }
  }

  installSelected() {
    if (!this.canInstallSelection()) return;
    const names = Array.from(this.selectedDiscovered());
    void this.runInstall(names);
  }

  backToForm() {
    if (this.installing()) return;
    if (this.discoveryId) {
      void this.api.cancelSkillDiscovery(this.discoveryId);
      this.discoveryId = null;
    }
    this.discoveredSkills.set([]);
    this.selectedDiscovered.set(new Set<string>());
    this.committedSource.set('');
    this.stage.set('form');
  }

  private resetInstallForm() {
    this.installSource.set('');
    this.installSkillName.set('');
    this.discoveredSkills.set([]);
    this.selectedDiscovered.set(new Set<string>());
    this.committedSource.set('');
    this.stage.set('form');
  }

  async remove(skill: InstalledSkill, agent: SkillAgent, scope: SkillScope) {
    const ok = await firstValueFrom(
      this.dialogs.confirm({
        title: this.translate.instant('modals.skills.remove_confirm_title'),
        message: this.translate.instant('modals.skills.remove_confirm_message', { name: skill.name }),
        confirmLabel: this.translate.instant('modals.skills.remove'),
        cancelLabel: this.translate.instant('common.cancel'),
        danger: true,
      }),
    );
    if (!ok) return;
    const key = `${scope}::${agent}::${skill.name}`;
    this.removingId.set(key);
    this.errorMessage.set(null);
    try {
      const result = await this.api.removeSkill({
        project: this.data.project,
        skillName: skill.name,
        agent,
        scope,
      });
      if (result.ok) {
        this.toast.show(
          this.translate.instant('modals.skills.remove_ok'),
          { kind: 'success' },
        );
        await this.refresh();
      } else {
        this.toast.show(
          result.error ?? this.translate.instant('modals.skills.remove_error'),
          { kind: 'error' },
        );
      }
    } catch (err) {
      this.toast.show(
        err instanceof Error ? err.message : String(err),
        { kind: 'error' },
      );
    } finally {
      this.removingId.set(null);
    }
  }
}
