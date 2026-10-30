import {
  ChangeDetectionStrategy, Component, computed, input, model,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslateModule } from '@ngx-translate/core';
import { ButtonComponent, CheckboxComponent, SearchInputComponent } from '@devia/ui';
import { filterDiscovered } from '../../utils/skill-filters';
import type { DiscoveredSkill } from '../../../../../types/devia';

/**
 * Discovery pick stage: multi-select list of every skill found in the
 * temp clone. The query and the selected set are owned by the parent
 * (model two-way bindings) because the shell-footer confirm button
 * installs the selection; select-all/clear stay tab-local actions on
 * that shared set.
 */
@Component({
  selector: 'ds-skills-pick-stage',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    ButtonComponent, CheckboxComponent, SearchInputComponent,
    TranslateModule,
  ],
  templateUrl: './skills-pick-stage.component.html',
  styleUrl: './skills-pick-stage.component.scss',
})
export class SkillsPickStageComponent {
  readonly skills = input.required<DiscoveredSkill[]>();
  readonly committedSource = input.required<string>();
  readonly installing = input.required<boolean>();
  readonly log = input.required<string[]>();
  readonly errorMessage = input.required<string | null>();

  readonly query = model.required<string>();
  readonly selected = model.required<Set<string>>();

  readonly filteredSkills = computed(() =>
    filterDiscovered(this.skills(), this.query()),
  );
  readonly selectedCount = computed(() => this.selected().size);
  readonly logText = computed(() => this.log().join('\n'));

  isSelected(name: string): boolean {
    return this.selected().has(name);
  }

  toggleSkill(name: string): void {
    const next = new Set(this.selected());
    if (next.has(name)) next.delete(name); else next.add(name);
    this.selected.set(next);
  }

  toggleAll(value: boolean): void {
    if (value) {
      this.selected.set(new Set(this.skills().map((s) => s.name)));
    } else {
      this.selected.set(new Set<string>());
    }
  }
}
