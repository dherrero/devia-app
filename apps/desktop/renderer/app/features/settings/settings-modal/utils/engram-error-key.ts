import type { ImportEngramResult } from '../../../../../../shared/domain/memory';

/**
 * Maps a failed `ImportEngramResult` reason to a display i18n key under
 * `modals.engram_import.*`. Shared by the Settings → Memory section (S-1).
 */
export function engramErrorKey(reason: Exclude<ImportEngramResult, { ok: true }>['reason']): string {
  switch (reason) {
    case 'engram-binary-missing': return 'modals.engram_import.error_binary_missing';
    case 'engram-export-timeout': return 'modals.engram_import.error_timeout';
    case 'engram-export-failed':  return 'modals.engram_import.error_export_failed';
    case 'engram-parse-error':    return 'modals.engram_import.error_parse';
  }
}
