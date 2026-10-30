import { ChangeDetectionStrategy, Component } from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';

/**
 * Multi-execution panel placeholder route (E-DSK-08 #253).
 *
 * Lives behind a `pro-multiexec` chunk so the EntitlementChunkLoader
 * (ticket #254) can detect and gate it. Multi-execution support is being
 * delivered on a separate feature branch (see feat/multi-execution-per-project);
 * once both land, this route will expose the per-project orchestration
 * surface that the split-pane shell does not.
 *
 * Intentionally minimal — the body is a stub so the build's chunk-naming
 * pipeline produces an identifiable `pro-multiexec.<hash>.js` artefact.
 */
@Component({
  selector: 'ds-multi-execution-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslateModule],
  templateUrl: './pro-multiexec.component.html',
  styleUrl: './pro-multiexec.component.scss',
})
// Default export so the named class identifier does not leak into the
// boot bundle. See pro-pinned.component.ts for the same rationale.
export default class MultiExecutionPanelComponent {}
