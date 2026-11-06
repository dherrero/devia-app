import type { GraphQueries } from '../db/queries';

// Runs inside the worker on the building DB, after parsing and before the atomic swap.
// Intentionally empty until reference resolution and community detection land; it lives
// here because a worker thread cannot receive those steps as functions.
export const postIndex: (db: GraphQueries, root: string) => Promise<void> = async () => {
  // no-op for now
};
