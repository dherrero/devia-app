import {
  ChangeDetectionStrategy, Component, computed, inject, input, model, output,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import {
  CheckboxComponent, InputComponent, RadioGroupComponent, type RadioOption,
} from '@devia/ui';
import { ALL_AGENTS } from '../../models/skill-agents.model';
import type { SkillAgent, SkillScope } from '../../../../../types/devia';

/**
 * Install form stage: source + optional skill filter + agents + scope.
 * The form values are owned by the parent (model two-way bindings)
 * because the shell-footer primary button reads them to decide between
 * discovery and direct install. Enter on the source field bubbles up as
 * `submitted` so the parent can run the same primary action.
 */
@Component({
  selector: 'ds-skills-install-form',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    CheckboxComponent, InputComponent, RadioGroupComponent,
    TranslateModule,
  ],
  templateUrl: './skills-install-form.component.html',
  styleUrl: './skills-install-form.component.scss',
})
export class SkillsInstallFormComponent {
  private readonly translate = inject(TranslateService);

  readonly agentOptions = ALL_AGENTS;

  readonly source = model.required<string>();
  readonly skillName = model.required<string>();
  readonly scope = model.required<SkillScope>();
  readonly agents = model.required<SkillAgent[]>();

  readonly busy = input.required<boolean>();
  readonly log = input.required<string[]>();
  readonly errorMessage = input.required<string | null>();

  readonly submitted = output<void>();

  readonly scopeOptions = computed<RadioOption[]>(() => [
    { value: 'project', label: this.translate.instant('modals.skills.scope_project') },
    { value: 'global', label: this.translate.instant('modals.skills.scope_global') },
  ]);

  readonly logText = computed(() => this.log().join('\n'));

  toggleAgent(id: SkillAgent): void {
    const cur = this.agents();
    this.agents.set(
      cur.includes(id) ? cur.filter((a) => a !== id) : [...cur, id],
    );
  }

  setScope(value: string): void {
    if (value !== 'project' && value !== 'global') return;
    this.scope.set(value);
  }
}
