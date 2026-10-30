import type { Feature, FeatureContext } from '../../shared/feature';
import type { ConfigRepository } from '../../shared/ports';
import { PtyManager } from './infrastructure/pty-manager';
import { registerTerminalIpc } from './ipc/terminal.ipc';

export interface TerminalDeps {
  config: ConfigRepository;
}

export function buildTerminalFeature(deps: TerminalDeps): Feature {
  const ptys = new PtyManager(deps.config);
  return {
    id: 'terminal',
    register(ctx: FeatureContext) {
      registerTerminalIpc(ctx, { ptys });
    },
    onBeforeQuit() {
      ptys.stopAll();
    },
  };
}
