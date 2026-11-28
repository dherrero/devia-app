import {
  MAIN_AGENT,
  buildAssignQuestion,
  parseAssignReply,
  type AssignQuestion,
  type RoleAgentMap,
  type WorkerRole,
} from '../../../../shared/domain/cross-agent';
import type { AssignAgentsInput } from '../../../../shared/domain/ui-tools';
import type { SetRoleAgentsResult } from './set-role-agents.use-case';

export interface AssignAgentsDeps {
  /** Agents that can take a worker now (installed, authenticated CLIs). */
  available: () => Promise<string[]>;
  /** The effective (main) agent of the project. */
  mainAgentId: (project: string) => string;
  /** What the project has saved. */
  current: (project: string) => RoleAgentMap;
  save: (project: string, map: RoleAgentMap) => SetRoleAgentsResult;
}

export type AssignPreparation =
  | { kind: 'cached'; text: string }
  | { kind: 'ask'; question: AssignQuestion; mainAgentId: string };

const describe = (map: RoleAgentMap, roles: readonly WorkerRole[]): string =>
  roles
    .map((role) => `${role} → ${map[role] === undefined || map[role] === MAIN_AGENT ? 'the main agent' : map[role]}`)
    .join(', ');

const NEXT_STEP =
  'Tag each task of the plan with its role (implementer or reviewer) and, once the plan runs, hand them out with devia_spawn_agent.';

/**
 * "Which agent runs which role" for a project (S-56 T9). The answer is cached
 * per project, so a plan asks only about what is still unanswered or no longer
 * possible; `reassign` asks again on purpose. The question itself is drawn by
 * the desktop card or the Telegram text; this class only decides WHAT to ask
 * and what to save, so both channels behave the same.
 */
export class AssignAgentsUseCase {
  constructor(private readonly deps: AssignAgentsDeps) {}

  async prepare(project: string, input: AssignAgentsInput): Promise<AssignPreparation> {
    const available = await this.deps.available();
    const mainAgentId = this.deps.mainAgentId(project);
    const saved = this.deps.current(project);

    if (!available.some((id) => id !== mainAgentId)) {
      return {
        kind: 'cached',
        text: `Only the main agent is usable right now, so there is nothing to choose: every role stays with it. Continue the plan as usual.`,
      };
    }

    const usable = (role: WorkerRole): boolean => {
      const value = saved[role];
      return value !== undefined && (value === MAIN_AGENT || available.includes(value));
    };
    const toAsk = input.reassign ? input.roles : input.roles.filter((role) => !usable(role));
    if (toAsk.length === 0) {
      return {
        kind: 'cached',
        text: `Saved for this project: ${describe(saved, input.roles)}. ${NEXT_STEP} If the user asks to change it, call devia_assign_agents again with reassign: true.`,
      };
    }
    return { kind: 'ask', question: buildAssignQuestion(toAsk, available, mainAgentId), mainAgentId };
  }

  async finish(project: string, question: AssignQuestion, answerText: string): Promise<string> {
    const parsed = parseAssignReply(answerText, question);
    if (!parsed.ok) {
      return 'The assignment could not be read, so nothing changed: every role stays as it was (the main agent unless already saved). Continue the plan without asking again.';
    }
    const merged: RoleAgentMap = { ...this.deps.current(project), ...parsed.map };
    const saved = this.deps.save(project, merged);
    if (!saved.accepted) {
      return `The assignment could not be saved (${saved.reason}), so nothing changed. Continue the plan without splitting roles.`;
    }
    return `The user chose: ${describe(saved.map, question.roles)} (saved for this project). ${NEXT_STEP}`;
  }
}
