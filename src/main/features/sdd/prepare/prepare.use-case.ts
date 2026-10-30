import type { SddPromptResult } from '../../../../shared/domain/sdd';
import type { KanbanUseCase } from '../kanban/application/kanban.use-case';
import { buildInitPrompt, buildPreparePrompt } from './prompts';

/**
 * SDD orchestration (E-DSK-12 T3/T9).
 *
 * Thin layer that turns a bootstrap decision into an agent
 * instruction. It does NOT spawn the agent — the renderer dispatches
 * the returned prompt through the existing `sendInstruction` path so
 * chat history, streaming and session persistence stay unified.
 *
 * `prepare` handles existing projects (analyse + guidance files +
 * backlog seeding). `init` handles new projects: it creates the first
 * spec from the user's intent up front so the agent has a target spec
 * id to expand into tasks.
 */
export class PrepareUseCase {
  constructor(private readonly kanban: KanbanUseCase) {}

  /** T3 — existing project. `language` pins the chat reply language. */
  prepare(projectName: string, language?: string): SddPromptResult {
    return { prompt: buildPreparePrompt(projectName, language), mode: 'plan' };
  }

  /** T9 — new project. Creates the seed spec, returns its id + the
   *  agent prompt that expands it into a backlog. */
  init(
    projectPath: string,
    projectName: string,
    intent: string,
    title?: string,
    language?: string,
  ): SddPromptResult {
    const specTitle = (title ?? deriveTitle(intent)).trim() || 'Objetivo inicial';
    const spec = this.kanban.createSpec(projectPath, specTitle, intent.trim());
    const prompt = buildInitPrompt({
      projectName,
      specId: spec.id,
      specTitle: spec.title,
      intent,
      ...(language !== undefined && { language }),
    });
    return { prompt, specId: spec.id, mode: 'plan' };
  }
}

/** Derive a short spec title from a free-text intent (first line / clause). */
function deriveTitle(intent: string): string {
  const firstLine = intent.split(/\r?\n/)[0]?.trim() ?? '';
  const clause = firstLine.split(/[.;:]/)[0]?.trim() ?? firstLine;
  const title = clause.length > 0 ? clause : firstLine;
  return title.length > 80 ? `${title.slice(0, 77)}…` : title;
}
