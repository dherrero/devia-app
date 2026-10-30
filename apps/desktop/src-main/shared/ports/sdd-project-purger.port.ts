/**
 * Write-side port that removes Devia's per-project SDD cache (kanban
 * board + bootstrap marker) when a project is trashed.
 *
 * Implemented by the SDD feature (E-DSK-12) and consumed by the
 * workspace `TrashProjectUseCase`. Kept here so workspace never imports
 * from inside `src-main/features/sdd/` (feature isolation). The
 * composition root wires the concrete instance.
 *
 * Takes an ABSOLUTE project path — the SDD store keys by absolute path.
 */
export interface SddProjectPurger {
  purge(absProjectPath: string): void;
}
