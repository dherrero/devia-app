/**
 * Cross-feature persistence facade. Owned by `shared/persistence/` because
 * `state.json` aggregates fields from several features (projects,
 * pinnedProjects).
 *
 * Use cases that mutate any of those call `save()` after the mutation; the
 * registries themselves remain pure.
 */
export interface StateStore {
  load(): void;
  save(): void;
}
