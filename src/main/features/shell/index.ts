import { shell } from 'electron';
import type { Feature, FeatureContext } from '../../shared/feature';
import { IPC } from '../../../shared/contracts/ipc-channels';
import type { IdeId } from '../../../shared/domain/ide';
import * as path from 'node:path';
import type { ConfigRepository } from '../../shared/ports';
import { listIdes, openInIde } from './ide';
import { decideShellPath } from './path-policy';

/**
 * Reads `process.env.DEVIA_SAAS_URL` lazily so a test can stub it before
 * the IPC fires. The handler also strips a trailing slash so concatenation
 * with `/upgrade?feature=…` is unambiguous.
 */
function resolveSaasOrigin(): string {
  const raw = process.env['DEVIA_SAAS_URL']?.trim() ?? '';
  return raw.endsWith('/') ? raw.slice(0, -1) : raw;
}

/**
 * Build the upgrade deep link for a given feature slug. Exported so the
 * unit spec can assert against the exact URL shape without spawning the
 * full Electron app. The feature slug is encoded with encodeURIComponent
 * so future slugs containing spaces or unicode survive the round-trip
 * cleanly. Returns `null` when no SaaS origin is configured, so a build
 * without `DEVIA_SAAS_URL` never opens anything.
 */
export function buildUpgradeUrl(feature: string): string | null {
  const origin = resolveSaasOrigin();
  if (!origin) return null;
  return `${origin}/upgrade?feature=${encodeURIComponent(feature)}`;
}

export interface ShellFeatureDeps {
  config: ConfigRepository;
}

export function buildShellFeature({ config }: ShellFeatureDeps): Feature {
  // workspaceRoot + the Devia-owned folders a card can legitimately point at
  // (outbox archive, attachments, session worktrees). Read lazily: the
  // workspace root can change at runtime.
  const allowedRoots = (): string[] => {
    const { workspaceRoot } = config.get();
    const dir = config.deviaDir();
    return [
      ...(workspaceRoot ? [workspaceRoot] : []),
      path.join(dir, 'outbox-archive'),
      path.join(dir, 'attachments'),
      path.join(dir, 'worktrees'),
    ];
  };

  return {
    id: 'shell',
    register(ctx: FeatureContext) {
      // Only media / plain folders are opened; any other file (a `.command`,
      // `.app`, `.bat` the agent produced) is revealed instead of executed.
      ctx.ipc.handle(IPC.shellOpenPath, async (_e, p: string) => {
        const d = decideShellPath(p, allowedRoots());
        if (d.action === 'open') return shell.openPath(d.path);
        if (d.action === 'reveal') shell.showItemInFolder(d.path);
        return '';
      });

      ctx.ipc.handle(IPC.shellReveal, (_e, p: string) => {
        const d = decideShellPath(p, allowedRoots());
        if (d.action !== 'deny') shell.showItemInFolder(d.path);
        return true;
      });

      // Open the given absolute path in an IDE. The catalog + per-OS launch
      // logic (detection, `open -a` on macOS, PATH lookup on win/linux) lives
      // in ./ide. `ideId` is the renderer's chosen IDE; when omitted we fall
      // back to the first installed one.
      ctx.ipc.handle(IPC.shellOpenInIde, (_e, p: string, ideId?: IdeId) => openInIde(p, ideId));

      // List the IDEs detected on this machine so the renderer can render the
      // "open in IDE" selector with only the installed ones.
      ctx.ipc.handle(IPC.shellListIdes, () => listIdes());

      // E-DSK-08 #258 — opens the saas upgrade page in the default browser.
      // The renderer never receives the URL; the main process is the single
      // source of truth so a future env override (different staging origin,
      // for instance) does not require a renderer rebuild.
      ctx.ipc.handle(IPC.shellOpenUpgrade, async (_e, feature: string) => {
        const safe = typeof feature === 'string' && feature.length > 0
          ? feature : 'unknown';
        const url = buildUpgradeUrl(safe);
        if (url) await shell.openExternal(url);
      });
    },
  };
}

