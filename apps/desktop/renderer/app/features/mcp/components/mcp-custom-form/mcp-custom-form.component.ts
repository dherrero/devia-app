import {
  ChangeDetectionStrategy, Component, computed, inject, input, model,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import {
  CheckboxComponent, InputComponent, RadioGroupComponent, TextareaComponent, type RadioOption,
} from '@devia/ui';
import { ALL_AGENTS, type FormState } from '../../models/mcp-form.model';
import type { McpAgentId } from '../../../../../types/devia';

/**
 * "Personalizada" tab: manual command + args + env form. The form state
 * is owned by the parent (model two-way binding) because the parent's
 * footer install button and the catalog-seeded install both read it.
 */
@Component({
  selector: 'ds-mcp-custom-form',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    CheckboxComponent, InputComponent, RadioGroupComponent, TextareaComponent,
    TranslateModule,
  ],
  templateUrl: './mcp-custom-form.component.html',
  styleUrl: './mcp-custom-form.component.scss',
})
export class McpCustomFormComponent {
  private readonly translate = inject(TranslateService);

  readonly allAgents = ALL_AGENTS;

  readonly form = model.required<FormState>();
  /** Active project path; empty string hides the scope toggle. */
  readonly projectPath = input.required<string>();

  readonly scopeOptions = computed<RadioOption[]>(() => [
    { value: 'global', label: this.translate.instant('mcp.modal.scope_global') },
    { value: 'project', label: this.translate.instant('mcp.modal.scope_project') },
  ]);

  toggleAgent(id: McpAgentId, checked: boolean): void {
    const next = new Set(this.form().agents);
    if (checked) next.add(id); else next.delete(id);
    this.form.update((f) => ({ ...f, agents: next }));
  }

  updateFormText(key: 'id' | 'name' | 'description' | 'command' | 'argsText' | 'envText', value: string): void {
    this.form.update((f) => ({ ...f, [key]: value }));
  }

  setScope(value: string): void {
    if (value !== 'global' && value !== 'project') return;
    this.form.update((f) => ({ ...f, scope: value }));
  }
}
