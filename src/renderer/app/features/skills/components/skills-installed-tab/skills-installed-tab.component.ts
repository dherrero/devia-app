import {
  ChangeDetectionStrategy, Component, computed, input, output, signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslateModule } from '@ngx-translate/core';
import { LucidePackageSearch, LucideRefreshCw, LucideTrash2 } from '@lucide/angular';
import { ButtonComponent, IconComponent, SearchInputComponent } from '@devia/ui';
import { agentLabel } from '../../models/skill-agents.model';
import { filterInstalled, installedKey } from '../../utils/skill-filters';
import type { InstalledSkill, SkillAgent, SkillScope } from '../../../../../types/devia';

export interface SkillRemoveRequest {
  skill: InstalledSkill;
  agent: SkillAgent;
  scope: SkillScope;
}

/**
 * "Instaladas" tab: project/global skill sidebar + detail panel with
 * per-agent remove buttons. The search query and the selected item live
 * in tab-local state; remove/refresh bubble up to the parent, which owns
 * the IPC orchestration.
 */
@Component({
  selector: 'ds-skills-installed-tab',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    ButtonComponent, IconComponent, SearchInputComponent,
    TranslateModule,
  ],
  templateUrl: './skills-installed-tab.component.html',
  styleUrl: './skills-installed-tab.component.scss',
})
export class SkillsInstalledTabComponent {
  readonly LucidePackageSearch = LucidePackageSearch;
  readonly LucideRefreshCw = LucideRefreshCw;
  readonly LucideTrash2 = LucideTrash2;

  readonly projectSkills = input.required<InstalledSkill[]>();
  readonly globalSkills = input.required<InstalledSkill[]>();
  readonly loading = input.required<boolean>();
  readonly busy = input.required<boolean>();

  readonly removeRequested = output<SkillRemoveRequest>();
  readonly refreshRequested = output<void>();

  /** Live filter over both project + global lists. */
  readonly query = signal('');
  readonly selectedKey = signal<string | null>(null);

  readonly installedKey = installedKey;
  readonly agentLabel = agentLabel;

  readonly filteredProjectSkills = computed(() =>
    filterInstalled(this.projectSkills(), this.query()),
  );
  readonly filteredGlobalSkills = computed(() =>
    filterInstalled(this.globalSkills(), this.query()),
  );
  readonly filteredSkills = computed(() => [
    ...this.filteredProjectSkills(),
    ...this.filteredGlobalSkills(),
  ]);
  readonly selectedSkill = computed(() => {
    const all = this.filteredSkills();
    if (all.length === 0) return null;
    const key = this.selectedKey();
    return all.find((skill) => installedKey(skill) === key) ?? all[0];
  });
}
