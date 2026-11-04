import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { Feature, FeatureContext } from '../../shared/feature';
import type { ConfigRepository, StarterKitRun, StarterKitsPort } from '../../shared/ports';
import { IPC } from '../../../shared/contracts/ipc-channels';
import {
  SUPERPOWERS_KIT_ID,
  resolveKitEnabled,
  type StarterKitSetRequest,
  type StarterKitSettings,
  type StarterKitView,
} from '../../../shared/domain/starter-kit';

import { buildSuperpowersProtocol, wrapBootstrap } from './domain/superpowers-protocol';
import { materializeKit, type MaterializedKit } from './infrastructure/kit-materializer';
import { detectNativeSuperpowers } from './infrastructure/native-detector';

/**
 * Starter kits (S-38): methodology bundles Devia ships with the app and
 * delivers to every agent through its own harness — never by writing into a
 * user's repository or home. Today: Superpowers.
 *
 * The bundled copy is materialised once per version under
 * `<deviaDir>/kits/superpowers/` (read-only) and handed to the run core
 * through `StarterKitsPort`; the core and each agent's mapper decide how it
 * reaches the CLI (native plugin for Claude, prompt + `devia_skill` for the rest).
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
  let run: Omit<StarterKitRun, 'id'> | null = null;

  const settings = (): StarterKitSettings | undefined => deps.config.get().starterKits?.[SUPERPOWERS_KIT_ID];
  const save = (next: StarterKitSettings): void => {
    deps.config.set({ starterKits: { ...deps.config.get().starterKits, [SUPERPOWERS_KIT_ID]: next } });
  };
  const absProject = (projectPath: string | undefined): string | undefined => {
    if (!projectPath) return undefined;
    const root = deps.config.get().workspaceRoot;
    return root && !path.isAbsolute(projectPath) ? path.resolve(root, projectPath) : projectPath;
  };

  const materialize = (): void => {
    try {
      kit = materializeKit(
        path.join(deps.bundledKitsDir(), SUPERPOWERS_KIT_ID),
        path.join(deps.config.deviaDir(), 'kits', SUPERPOWERS_KIT_ID),
      );
      let bootstrap = '';
      try {
        bootstrap = wrapBootstrap(fs.readFileSync(path.join(kit.dir, 'skills', 'using-superpowers', 'SKILL.md'), 'utf8'));
      } catch (err) {
        throw new Error(`bootstrap skill unreadable: ${err instanceof Error ? err.message : String(err)}`);
      }
      run = { dir: kit.dir, skillsDir: path.join(kit.dir, 'skills'), bootstrap, protocol: buildSuperpowersProtocol(kit.dir) };
    } catch (err) {
      kit = null;
      run = null;
      console.warn('[devia:starter-kits] superpowers kit unavailable:', err instanceof Error ? err.message : String(err));
    }
  };

  const skillNames = (): string[] => {
    if (!kit) return [];
    try {
      return fs.readdirSync(path.join(kit.dir, 'skills'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
    } catch {
      return [];
    }
  };

  const status = (projectPath: string | undefined): StarterKitView => {
    const current = settings();
    const abs = absProject(projectPath);
    const override = abs !== undefined ? current?.projects?.[abs] : undefined;
    const cfg = deps.config.get();
    return {
      id: SUPERPOWERS_KIT_ID,
      tag: kit?.pin.tag ?? '',
      commit: kit?.pin.commit ?? '',
      skills: skillNames(),
      materialized: kit !== null,
      enabled: current?.enabled === true,
      introSeen: current?.introSeen === true,
      projectOverride: typeof override === 'boolean' ? override : null,
      effective: kit !== null && resolveKitEnabled(current, abs ?? ''),
      nativeDetected: detectNativeSuperpowers(cfg.agentId, home(), abs ?? cfg.workspaceRoot ?? ''),
    };
  };

  const set = (req: StarterKitSetRequest): StarterKitView => {
    if (req.id !== SUPERPOWERS_KIT_ID) return status(req.projectPath);
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
      if (detectNativeSuperpowers(agentId, home(), cwd)) return null;
      return { id: SUPERPOWERS_KIT_ID, ...run };
    },
  };

  const feature: Feature = {
    id: 'starter-kits',
    register(ctx: FeatureContext) {
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
