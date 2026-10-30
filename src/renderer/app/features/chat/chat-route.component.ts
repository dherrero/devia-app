import { ChangeDetectionStrategy, Component } from '@angular/core';
import { ChatPanesContainerComponent } from './panes/chat-panes-container.component';

/**
 * Default route component. Thin wrapper around the existing
 * {@link ChatPanelComponent} so it can be loaded lazily via
 * `loadComponent` without dragging the heavy chat dependency graph into
 * `main.js` at boot (ticket #253).
 *
 * The wrapper exists for two reasons:
 *   1. `ChatPanelComponent` is referenced from a static import elsewhere
 *      in the codebase (it is the chat surface). A dedicated thin route
 *      file gives Angular's build a deduplication-friendly entry point
 *      for the chunk-naming magic comment.
 *   2. Future refactors that add route-resolvers or component-level guards
 *      have a home that does not pollute the chat panel itself.
 */
@Component({
  selector: 'ds-chat-route',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ChatPanesContainerComponent],
  // S-13 T-143: the split-view container mounts the primary pane (real repo)
  // plus up to 3 additional panes (each its own session + worktree).
  templateUrl: './chat-route.component.html',
  styleUrl: './chat-route.component.scss',
})
export class ChatRouteComponent {}
