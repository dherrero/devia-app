import type { ProjectTech } from '../../../../shared/domain/project';
import type { UiToolName } from '../../../../shared/domain/ui-tools';
import { getGitStatusLine } from './git-context';
import { buildUiToolsHint } from './ui-tools-protocol';

const DEVIA_INTRO =
  'You are running inside Devia, a local desktop Electron client that streams your stdout into a chat bubble; the session is multi-turn and persistent, so you can wait for the user to answer on the next turn instead of guessing.';

const AGENTS_MD_LINE =
  'AGENTS.md at the repository root is the source of truth for how to work in this project: read it before non-trivial work, keep it updated whenever you change something significant, and ensure any CLAUDE.md (or other agent file) only points to it instead of duplicating its content.';

/**
 * Per-tech addenda. Only techs that need extra guidance are listed; any other
 * tech contributes nothing. Empty/missing entries are skipped during build so
 * they cost nothing on the command line.
 */
const TECH_SYSTEM_PROMPTS: Partial<Record<ProjectTech, string>> = {};

export interface SystemPromptOptions {
  /**
   * The `devia-ui` tools this run actually got (S-25). Only these are
   * announced: mentioning a tool the run cannot call is worse than saying
   * nothing, because the agent burns a turn on a call that is lost.
   */
  advertised?: readonly UiToolName[];
  projectPath?: string;
}

export function buildSystemPrompt(tech: ProjectTech, opts: SystemPromptOptions = {}): string {
  const extra = TECH_SYSTEM_PROMPTS[tech] ?? '';
  const uiToolsLine = buildUiToolsHint(opts.advertised ?? []);
  const base = [
    DEVIA_INTRO,
    ...(uiToolsLine ? [uiToolsLine] : []),
    AGENTS_MD_LINE,
    ...(extra ? [extra] : []),
  ].join(' ');
  const gitLine = opts.projectPath ? getGitStatusLine(opts.projectPath) : null;
  return gitLine ? `${base}\n${gitLine}` : base;
}
