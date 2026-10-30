import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import { LucideKeyRound, LucidePlus } from '@lucide/angular';
import { ButtonComponent, IconComponent } from '@devia/ui';
import type { McpCatalogEntry } from '../../../../../types/devia';

/** "Catálogo" tab: Devia-curated catalog cards with an install button. */
@Component({
  selector: 'ds-mcp-catalog-tab',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, IconComponent, TranslateModule],
  templateUrl: './mcp-catalog-tab.component.html',
  styleUrl: './mcp-catalog-tab.component.scss',
})
export class McpCatalogTabComponent {
  readonly LucideKeyRound = LucideKeyRound;
  readonly LucidePlus = LucidePlus;

  readonly catalog = input.required<ReadonlyArray<McpCatalogEntry>>();

  readonly installRequested = output<McpCatalogEntry>();
}
