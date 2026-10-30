import type { Feature, FeatureContext } from '../../shared/feature';
import type { ConfigRepository, SessionStore } from '../../shared/ports';
import { ScanSessionsUseCase } from './application/scan-sessions.use-case';
import { ImportSessionsUseCase } from './application/import-sessions.use-case';
import { FsClaudeProjectsReader } from './infrastructure/fs-claude-projects-reader';
import { FsCodexSessionsReader } from './infrastructure/fs-codex-sessions-reader';
import { FsGrokSessionsReader } from './infrastructure/fs-grok-sessions-reader';
import { claudeParser, codexParser, grokParser } from './parsers';
import type { ImportSource } from './domain/ports';
import { registerSessionImportIpc } from './ipc/session-import.ipc';

export interface SessionImportDeps {
  config: ConfigRepository;
  sessions: SessionStore;
}

/**
 * S-20 (generalises S-18): import pre-existing CLI-agent sessions into Devia's
 * session store for projects that live in the configured workspace. Adding an
 * agent is one entry in the registry below: a `SessionTranscriptReader` + a
 * `TranscriptParser`.
 */
export function buildSessionImportFeature(deps: SessionImportDeps): Feature {
  const sources: ImportSource[] = [
    { reader: new FsClaudeProjectsReader(), parser: claudeParser },
    { reader: new FsCodexSessionsReader(), parser: codexParser },
    { reader: new FsGrokSessionsReader(), parser: grokParser },
  ];
  const scan = new ScanSessionsUseCase({ config: deps.config, sessions: deps.sessions, sources });
  const importSessions = new ImportSessionsUseCase({ config: deps.config, sessions: deps.sessions, sources });

  return {
    id: 'session-import',
    register(ctx: FeatureContext) {
      registerSessionImportIpc(ctx, { scan, import: importSessions });
    },
  };
}
