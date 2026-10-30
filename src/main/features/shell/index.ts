import { shell } from 'electron';
import type { Feature, FeatureContext } from '../../shared/feature';
import { IPC } from '../../../shared/contracts/ipc-channels';
import type { IdeId } from '../../../shared/domain/ide';
import { listIdes, openInIde } from './ide';

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

export function buildShellFeature(): Feature {
  return {
    id: 'shell',
    register(ctx: FeatureContext) {
      ctx.ipc.handle(IPC.shellOpenPath, (_e, p: string) => shell.openPath(p));

      ctx.ipc.handle(IPC.shellReveal, (_e, p: string) => {
        shell.showItemInFolder(p);
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

