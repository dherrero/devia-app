/** Starter kits (S-38): methodology bundles Devia ships and delivers to every agent. */
export const SUPERPOWERS_KIT_ID = 'superpowers' as const;
export type StarterKitId = typeof SUPERPOWERS_KIT_ID;

export interface StarterKitSettings {
  /** Global switch. Absent = undecided (an existing install, until the user answers the intro card). */
  enabled?: boolean;
  /** Per-project override keyed by the BASE checkout's absolute path; absent = follow the global switch. */
  projects?: Record<string, boolean>;
  /** The user has seen the first-run card. */
  introSeen?: boolean;
}

export type StarterKitsConfig = Partial<Record<StarterKitId, StarterKitSettings>>;

export interface StarterKitView {
  id: StarterKitId;
  tag: string;
  commit: string;
  skills: string[];
  /** The bundled files could be copied to the data dir; false disables delivery. */
  materialized: boolean;
  enabled: boolean;
  introSeen: boolean;
  /** `null` = the project follows the global switch. */
  projectOverride: boolean | null;
  /** What a run in this project gets, before native-install detection. */
  effective: boolean;
  /** The active agent already has Superpowers installed itself: Devia will not duplicate the bootstrap. */
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
