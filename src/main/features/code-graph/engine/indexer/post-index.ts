import type { GraphQueries } from '../db/queries';
import { computeCommunities, persistCommunities } from '../graph/communities';
import { resolveReferences, type ResolveStats } from '../resolution/resolver';

/** The one resolution step of the pipeline: full index (`postIndex`), sync and tests all use it. */
export function resolveGraph(db: GraphQueries, root: string, onlyFiles?: string[]): ResolveStats {
  return resolveReferences(db, root, onlyFiles);
}

// Runs inside the worker on the building DB, after parsing and before the atomic swap; it
// lives here because a worker thread cannot receive these steps as functions.
export const postIndex: (db: GraphQueries, root: string) => Promise<void> = async (db, root) => {
  resolveGraph(db, root);
  persistCommunities(db, computeCommunities(db).assignments);
};
