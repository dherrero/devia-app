export type StalenessReason = 'commit' | 'config' | 'dirty';

export interface StalenessArgs {
  builtAtCommit?: string | undefined;
  headCommit?: string | undefined;
  /** Pending changed files; the caller passes 0 while auto-update is on. */
  dirtyFiles: number;
  configChanged?: boolean | undefined;
}

export function computeStaleness(args: StalenessArgs): { stale: boolean; reason: StalenessReason | null } {
  if (args.configChanged === true) return { stale: true, reason: 'config' };
  if (args.builtAtCommit !== undefined && args.headCommit !== undefined && args.headCommit !== args.builtAtCommit) {
    return { stale: true, reason: 'commit' };
  }
  if (args.dirtyFiles > 0) return { stale: true, reason: 'dirty' };
  return { stale: false, reason: null };
}
