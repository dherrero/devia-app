import type {
  CreateSnapshotRequest,
  CreateSnapshotResult,
} from '../../../shared/domain/snapshot';

/**
 * Write-side port that captures a config snapshot BEFORE a
 * destructive operation. Implemented by the snapshot feature
 * (#270) and consumed by every feature that mutates user-facing
 * files (skills, MCP, prompt-packs, spec-kit).
 *
 * Kept here so the consuming features never import from inside
 * `src-main/features/snapshot/` directly (CLAUDE.md "Feature
 * isolation"). The composition root wires the concrete instance.
 */
export interface SnapshotCapturer {
  execute(req: CreateSnapshotRequest): CreateSnapshotResult;
}
