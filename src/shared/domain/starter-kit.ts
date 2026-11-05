/** Starter kits (S-38/S-39): methodology bundles Devia ships and delivers to every agent. */
export const DEVIA_METHOD_KIT_ID = 'devia-method' as const;
export type StarterKitId = typeof DEVIA_METHOD_KIT_ID;

export interface StarterKitSettings {
  /** Global switch. Absent = undecided (an existing install, until the user answers the intro card). */
  enabled?: boolean;
  /** Per-project override keyed by the BASE checkout's absolute path; absent = follow the global switch. */
  projects?: Record<string, boolean>;
  /** The user has seen the first-run card. */
  introSeen?: boolean;
}

/** Keys of any other kit id (an earlier build's) are tolerated on read and migrated at startup. */
export type StarterKitsConfig = Partial<Record<StarterKitId, StarterKitSettings>> & Record<string, StarterKitSettings | undefined>;

export type StarterKitSkillOrigin = 'literal' | 'derived' | 'own';

export interface StarterKitSkillView {
  name: string;
  /** literal = copied from the library the kit started from, derived = rewritten from one of its skills, own = written for Devia. */
  origin: StarterKitSkillOrigin;
  trigger: string;
}

export interface StarterKitView {
  id: StarterKitId;
  name: string;
  version: string;
  skills: StarterKitSkillView[];
  /** The bundled files could be copied to the data dir; false disables delivery. */
  materialized: boolean;
  enabled: boolean;
  introSeen: boolean;
  /** `null` = the project follows the global switch. */
  projectOverride: boolean | null;
  /** What a run in this project gets, before native-install detection. */
  effective: boolean;
  /** The active agent already has a method of this kind installed itself: Devia will not duplicate the bootstrap. */
  nativeDetected: boolean;
}

export interface StarterKitSetRequest {
  id: StarterKitId;
  enabled?: boolean;
  introSeen?: boolean;
  /** Base checkout path the override applies to. */
  projectPath?: string;
  /** `null` clears the override. */
  projectEnabled?: boolean | null;
}

export function resolveKitEnabled(settings: StarterKitSettings | undefined, projectPath: string): boolean {
  const override = settings?.projects?.[projectPath];
  if (typeof override === 'boolean') return override;
  return settings?.enabled === true;
}
