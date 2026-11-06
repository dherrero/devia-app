import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { Feature, FeatureContext } from '../../shared/feature';
import type { ConfigRepository, StarterKitRun, StarterKitsPort } from '../../shared/ports';
import { IPC } from '../../../shared/contracts/ipc-channels';
import {
  DEVIA_METHOD_KIT_ID,
  resolveKitEnabled,
  type StarterKitSetRequest,
  type StarterKitSettings,
  type StarterKitView,
} from '../../../shared/domain/starter-kit';

import { buildKitPrompt, parseKitManifest, type KitManifest } from './domain/kit-prompt';
import { materializeKit, removeKitTree, type MaterializedKit } from './infrastructure/kit-materializer';
import { detectNativeMethod } from './infrastructure/native-detector';

/**
 * Starter kits (S-39): the Devia Method, a development method of Devia's own,
 * shipped with the app and delivered to every agent through
 * Devia's own harness — never by writing into a user's repository or home.
 *
 * The bundled copy is materialised once per version under
 * `<deviaDir>/kits/devia-method/` and handed to the run core through
 * `StarterKitsPort`: the core appends its prompt and serves its skills with
 * `devia_skill`; each agent's mapper adds a native channel where it has one
 * (Claude loads it as a plugin for skill discovery).
 */
export interface StarterKitsDeps {
  config: ConfigRepository;
  /** Directory holding the bundled kits (`<resources>/kits`). */
  bundledKitsDir: () => string;
  home?: () => string;
}

export interface StarterKitsBuilt {
  readonly feature: Feature;
  readonly port: StarterKitsPort;
  status(projectPath: string | undefined): StarterKitView;
  set(req: StarterKitSetRequest): StarterKitView;
}

export function buildStarterKitsFeature(deps: StarterKitsDeps): StarterKitsBuilt {
  const home = deps.home ?? os.homedir;
  let kit: MaterializedKit | null = null;
  let manifest: KitManifest | null = null;
  let run: Omit<StarterKitRun, 'id'> | null = null;

  const settings = (): StarterKitSettings | undefined => deps.config.get().starterKits?.[DEVIA_METHOD_KIT_ID];
  const save = (next: StarterKitSettings): void => {
    deps.config.set({ starterKits: { ...deps.config.get().starterKits, [DEVIA_METHOD_KIT_ID]: next } });
  };
  const absProject = (projectPath: string | undefined): string | undefined => {
    if (!projectPath) return undefined;
    const root = deps.config.get().workspaceRoot;
    return root && !path.isAbsolute(projectPath) ? path.resolve(root, projectPath) : projectPath;
  };

  const materialize = (): void => {
    try {
      kit = materializeKit(
        path.join(deps.bundledKitsDir(), DEVIA_METHOD_KIT_ID),
        path.join(deps.config.deviaDir(), 'kits', DEVIA_METHOD_KIT_ID),
      );
      manifest = parseKitManifest(fs.readFileSync(path.join(kit.dir, 'kit.json'), 'utf8'));
      if (!manifest) throw new Error('kit.json is missing or invalid');
      const bootstrap = fs.readFileSync(path.join(kit.dir, 'skills', manifest.bootstrap, 'SKILL.md'), 'utf8');
      const skillsDir = path.join(kit.dir, 'skills');
      run = { dir: kit.dir, skillsDir, prompt: buildKitPrompt(manifest, bootstrap, skillsDir) };
    } catch (err) {
      kit = null;
      manifest = null;
      run = null;
      console.warn('[devia:starter-kits] devia-method kit unavailable:', err instanceof Error ? err.message : String(err));
    }
  };

  /**
   * An earlier build stored this setting under another kit id and left its files under `kits/`. Carry the
   * user's choice over (never over one already made for this kit) and remove what no kit of this build owns.
   */
  const migrateRetired = (): void => {
    const all = deps.config.get().starterKits ?? {};
    const retired = Object.keys(all).filter((id) => id !== DEVIA_METHOD_KIT_ID);
    if (retired.length > 0) {
      const inherited = all[DEVIA_METHOD_KIT_ID] ?? all[retired[0] as string];
      deps.config.set({ starterKits: { ...(inherited !== undefined && { [DEVIA_METHOD_KIT_ID]: inherited }) } });
    }
    const kitsRoot = path.join(deps.config.deviaDir(), 'kits');
    try {
      for (const entry of fs.readdirSync(kitsRoot, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name !== DEVIA_METHOD_KIT_ID) removeKitTree(path.join(kitsRoot, entry.name));
      }
    } catch { /* no kits directory yet */ }
  };

  const status = (projectPath: string | undefined): StarterKitView => {
    const current = settings();
    const abs = absProject(projectPath);
    const override = abs !== undefined ? current?.projects?.[abs] : undefined;
    const cfg = deps.config.get();
    return {
      id: DEVIA_METHOD_KIT_ID,
      name: manifest?.name ?? 'Devia Method',
      version: manifest?.version ?? '',
      skills: (manifest?.skills ?? []).map((s) => ({ name: s.name, origin: s.origin, trigger: s.trigger })),
      materialized: kit !== null,
      enabled: current?.enabled === true,
      introSeen: current?.introSeen === true,
      projectOverride: typeof override === 'boolean' ? override : null,
      effective: kit !== null && resolveKitEnabled(current, abs ?? ''),
      nativeDetected: detectNativeMethod(cfg.agentId, home(), abs ?? cfg.workspaceRoot ?? ''),
    };
  };

  const set = (req: StarterKitSetRequest): StarterKitView => {
    if (req.id !== DEVIA_METHOD_KIT_ID) return status(req.projectPath);
    const next: StarterKitSettings = { ...settings() };
    if (typeof req.enabled === 'boolean') next.enabled = req.enabled;
    if (typeof req.introSeen === 'boolean') next.introSeen = req.introSeen;
    const abs = absProject(req.projectPath);
    if (abs !== undefined && req.projectEnabled !== undefined) {
      const projects = { ...next.projects };
      if (req.projectEnabled === null) delete projects[abs];
      else projects[abs] = req.projectEnabled;
      next.projects = projects;
    }
    save(next);
    return status(req.projectPath);
  };

  const port: StarterKitsPort = {
    resolve({ agentId, projectCheckout, cwd }) {
      if (!run || !resolveKitEnabled(settings(), projectCheckout)) return null;
      if (detectNativeMethod(agentId, home(), cwd)) return null;
      return { id: DEVIA_METHOD_KIT_ID, ...run };
    },
  };

  const feature: Feature = {
    id: 'starter-kits',
    register(ctx: FeatureContext) {
      migrateRetired();
      materialize();
      // A brand-new install (no workspace picked yet) starts with the kit ON;
      // an existing one is never switched silently — it answers the intro card.
      if (settings()?.enabled === undefined && !deps.config.get().workspaceRoot) save({ ...settings(), enabled: true });
      ctx.ipc.handle(IPC.starterKitsStatus, (_e, projectPath?: string) => status(projectPath));
      ctx.ipc.handle(IPC.starterKitsSet, (_e, req: StarterKitSetRequest) => set(req));
    },
  };

  return { feature, port, status, set };
}
