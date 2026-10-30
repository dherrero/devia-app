import * as fs from 'node:fs';
import * as path from 'node:path';

import type {
  SubAgentCliId,
  SubAgentInstallResult,
} from '../../../../shared/domain/sub-agents';
import { SubAgentReader, DEVIA_DIR, SUB_AGENTS_SUBDIR } from '../infrastructure/sub-agent-reader';
import { SubAgentWriter } from '../infrastructure/sub-agent-writer';
import type { SnapshotCapturer } from '../../../shared/ports';

/**
 * Remove a sub-agent from the project: drops the
 * `.devia/sub-agents/<name>.md` file AND every CLI it was synced to.
 *
 * Idempotent — calling on a missing sub-agent is a no-op (ok=true,
 * affectedFiles=[]). The renderer relies on that for the "Eliminar"
 * confirm-dialog flow.
 */
export class RemoveSubAgentUseCase {
  constructor(
    private readonly reader: SubAgentReader,
    private readonly writer: SubAgentWriter,
    private readonly snapshot?: SnapshotCapturer,
  ) {}

  execute(projectPath: string, name: string): SubAgentInstallResult {
    if (!projectPath || !safeIsDir(projectPath)) {
      return { ok: false, affectedFiles: [], error: 'Proyecto inválido' };
    }
    const sourceFile = path.join(
      projectPath, DEVIA_DIR, SUB_AGENTS_SUBDIR, `${name}.md`,
    );
    const previous = this.reader.readOne(sourceFile);
    if (!previous) {
      return { ok: true, affectedFiles: [] };
    }

    const previousAgents = previous.agents as SubAgentCliId[];
    const removePaths = this.writer.pathsForRemove(name, previousAgents, projectPath);
    const allFiles = Array.from(new Set([sourceFile, ...removePaths]));

    let snapshotId: string | undefined;
    if (this.snapshot && allFiles.length > 0) {
      try {
        const snap = this.snapshot.execute({
          feature: 'manual',
          reason: `subAgents:remove "${name}"`,
          paths: allFiles,
          projectPath,
        });
        snapshotId = snap.id;
      } catch (err) {
        console.warn('[sub-agents] snapshot skipped:', (err as Error).message);
      }
    }

    try { fs.rmSync(sourceFile, { force: true }); } catch { /* swallow */ }
    const result = this.writer.removeAll(name, previousAgents, projectPath);

    return {
      ok: true,
      affectedFiles: [sourceFile, ...result.affectedFiles],
      ...(snapshotId !== undefined && { snapshotId }),
    };
  }
}

function safeIsDir(p: string): boolean {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}
