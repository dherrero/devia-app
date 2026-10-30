import type { FeatureContext } from '../../../shared/feature';
import { IPC } from '../../../../shared/contracts/ipc-channels';
import type { PtyManager } from '../infrastructure/pty-manager';
import type { PtySize } from '../domain/types';

export interface TerminalIpcDeps {
  ptys: PtyManager;
}

export function registerTerminalIpc(ctx: FeatureContext, deps: TerminalIpcDeps): void {
  ctx.ipc.handle(IPC.terminalStart, (_e, projectPath: string, size: Partial<PtySize> | undefined) => {
    return deps.ptys.start(projectPath, size ?? {}, {
      onData: (data) => ctx.send('terminal:data', { project: projectPath, data }),
      onExit: (info) => ctx.send('terminal:exit', { project: projectPath, ...info }),
    });
  });

  ctx.ipc.on(IPC.terminalWrite, (_e, projectPath: string, data: string) => {
    deps.ptys.write(projectPath, data);
  });

  ctx.ipc.on(IPC.terminalResize, (_e, projectPath: string, size: Partial<PtySize>) => {
    deps.ptys.resize(projectPath, size ?? {});
  });

  ctx.ipc.handle(IPC.terminalStop, (_e, projectPath: string) => deps.ptys.stop(projectPath));
}
