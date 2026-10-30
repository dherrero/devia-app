import type { Feature, FeatureContext } from '../../shared/feature';
import type {
  PinnedStore,
  ProjectRegistry,
  StateStore,
} from '../../shared/ports';
import type { TechDetector } from '../workspace/domain/ports';
import { IPC } from '../../../shared/contracts/ipc-channels';

export { InMemoryPinnedStore } from './infrastructure/in-memory-pinned-store';

export interface PinnedDeps {
  registry: ProjectRegistry;
  state: StateStore;
  tech: TechDetector;
  store: PinnedStore;
}

export function buildPinnedProjectsFeature(deps: PinnedDeps): Feature {
  return {
    id: 'pinned-projects',
    register(ctx: FeatureContext) {
      // Read-only snapshot enriched with tech + isRunning so the "Fijados"
      // section paints the correct icon on first render — even for pins
      // whose project lives outside the current nav-path view.
      ctx.ipc.handle(IPC.pinnedGet, () =>
        deps.store.list().map((p) => ({
          path: p,
          tech: deps.tech.detect(p),
          isRunning: deps.registry.isRunning(p),
        })),
      );

      ctx.ipc.handle(IPC.pinnedSet, (_e, paths: unknown) => {
        const next = deps.store.set(Array.isArray(paths) ? paths : []);
        deps.state.save();
        return next;
      });
    },
  };
}
