/**
 * Read-only view of the instruction queue for cross-feature guards (S-2 F0.4).
 * Owned by `features/queue`; consumed by `features/sessions` so a session
 * switch can refuse while items are still parked for that identity (they
 * would otherwise be dispatched into the newly chosen session, continuing the
 * previous conversation inside it).
 */
export interface QueueInspector {
  /** Number of parked (not yet dispatched) items for a run identity. */
  pendingCount(identity: string): number;
}
