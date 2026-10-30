import type { Feature, FeatureContext } from '../../shared/feature';
import type { ConfigRepository, SnapshotCapturer } from '../../shared/ports';
import { SubAgentReader } from './infrastructure/sub-agent-reader';
import { SubAgentWriter } from './infrastructure/sub-agent-writer';
import { InstallSubAgentUseCase } from './application/install-sub-agent.use-case';
import { RemoveSubAgentUseCase } from './application/remove-sub-agent.use-case';
import { AutoImportSubAgentsUseCase } from './application/auto-import.use-case';
import { registerSubAgentsIpc } from './ipc/sub-agents.ipc';

export interface SubAgentsDeps {
  /** Resolves the renderer's workspace-relative project paths to
   *  absolute before any filesystem work (#275 fix). */
  config: ConfigRepository;
  /** Optional snapshot capturer (#270). When wired, install / remove
   *  capture the affected files BEFORE mutating. */
  snapshot?: SnapshotCapturer;
}

/**
 * Cross-CLI sub-agent manager (#275).
 *
 * Devia owns `<project>/.devia/sub-agents/<name>.md` as the source
 * of truth. The synchroniser materialises each entry into every
 * selected CLI's native location. First open of a project triggers
 * an auto-import scan so cloned repos with pre-existing
 * `.claude/agents/`, `.cursor/agents/`, etc. land in Devia's
 * catalog automatically.
 */
export function buildSubAgentsFeature(deps: SubAgentsDeps): Feature {
  const reader = new SubAgentReader();
  const writer = new SubAgentWriter();
  const install = new InstallSubAgentUseCase(reader, writer, deps.snapshot);
  const remove = new RemoveSubAgentUseCase(reader, writer, deps.snapshot);
  const autoImport = new AutoImportSubAgentsUseCase(reader);

  return {
    id: 'sub-agents',
    register(ctx: FeatureContext) {
      registerSubAgentsIpc(ctx, { config: deps.config, reader, install, remove, autoImport });
    },
  };
}

export { SubAgentReader } from './infrastructure/sub-agent-reader';
export { SubAgentWriter } from './infrastructure/sub-agent-writer';
export { parseSubAgentFile, renderSubAgentFile } from './infrastructure/frontmatter';
