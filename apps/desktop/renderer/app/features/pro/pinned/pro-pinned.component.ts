import { ChangeDetectionStrategy, Component } from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';

/**
 * Pinned-projects feature placeholder route (E-DSK-08 #253).
 *
 * Lives behind a `pro-pinned` chunk so the EntitlementChunkLoader (ticket
 * #254) can detect and gate it. Today the renderer still surfaces pinned
 * projects through the sidebar — that surface is unchanged. Once the
 * chunk-loader lands, the sidebar's "fijados" entry will navigate here
 * for Pro users and the chunk-loader will reject Free-tier loads with
 * `paywall-requested` events that the upgrade toast (ticket #258) shows.
 *
 * Intentionally minimal: the real Pro UI is delivered later. Keeping the
 * file under `features/pinned/` future-proofs the path so the lazy import
 * in `app.routes.ts` does not need to move once the component grows.
 */
@Component({
  selector: 'ds-pinned',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslateModule],
  templateUrl: './pro-pinned.component.html',
  styleUrl: './pro-pinned.component.scss',
})
// Default export keeps the class identifier out of `main.js` — the router
// resolves `loadComponent: () => import(...)` against the `default` binding
// so no named property access leaks the Pro class name into the boot bundle.
export default class PinnedComponent {}
