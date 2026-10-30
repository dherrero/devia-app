import type { FeatureContext } from '../../../shared/feature';
import { IPC } from '../../../../shared/contracts/ipc-channels';
import type {
  ImportOptions,
  ImportSelection,
  ImportableAgent,
  ImportSummary,
} from '../../../../shared/domain/session-import';
import type { ScanSessionsUseCase } from '../application/scan-sessions.use-case';
import type { ImportSessionsUseCase } from '../application/import-sessions.use-case';

export interface SessionImportIpcDeps {
  scan: ScanSessionsUseCase;
  import: ImportSessionsUseCase;
}

export function registerSessionImportIpc(ctx: FeatureContext, deps: SessionImportIpcDeps): void {
  ctx.ipc.handle(IPC.sessionImportScan, (): ImportableAgent[] => {
    try {
      return deps.scan.execute();
    } catch {
      // Never leak host paths / crash the renderer on a scan error.
      return [];
    }
  });

  ctx.ipc.handle(
    IPC.sessionImportRun,
    (_e, selections: ImportSelection[], opts?: ImportOptions): ImportSummary => {
      try {
        return deps.import.execute(selections, opts);
      } catch {
        return { imported: 0, skipped: 0, failed: Array.isArray(selections) ? selections.length : 0 };
      }
    },
  );
}
