import type { WorkerRole } from '../../../../shared/domain/cross-agent';

export interface WorkerPromptInput {
  role: WorkerRole;
  taskId: string;
  /** Reviewer only: the commit the implementer started from, so `base..HEAD` is its work. */
  baseSha?: string;
}

const REPORT_CONTRACT = `Your final message is your report, in exactly this shape:

STATUS: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED
<three sentences: what you did, what you found, what is left>`;

const COMMON_RULES = `- Do not ask the user anything: nobody can answer. If something is ambiguous, take the smallest reasonable reading and say so in your report.
- Do not brainstorm and do not plan: the task is already specified and approved.
- Do not start other agents or subagents, and do not delegate.
- Stay inside this worktree; never touch another checkout.`;

/**
 * The brief a cross-agent worker receives (S-56). A worker starts with NO
 * context of the controller's conversation: the task on the board is the whole
 * brief, so the prompt only says where to read it, what is allowed and how to
 * report. Written in plain words so any CLI agent follows it.
 */
export function buildWorkerPrompt(input: WorkerPromptInput): string {
  return input.role === 'implementer' ? implementerPrompt(input) : reviewerPrompt(input);
}

function implementerPrompt({ taskId }: WorkerPromptInput): string {
  return `You are a dispatched implementer worker for Devia. You work alone, in your own git worktree, on a branch of your own.

Your task is kanban task ${taskId}. Read it first with kanban_get_task for "${taskId}": its body is your requirements, with the exact values to use verbatim. Do exactly that task, no more and no less.

Rules:
- Work test-first: write the failing test, watch it fail, then make it pass. Run the checks the task names.
- Commit your work in this worktree as the task's steps say. Never rewrite commits that are not yours.
${COMMON_RULES}

${REPORT_CONTRACT}
commit <sha>   (one line per commit you made)`;
}

function reviewerPrompt({ taskId, baseSha }: WorkerPromptInput): string {
  const range = baseSha
    ? `The implementer's work is the range \`${baseSha}..HEAD\` of this branch: read it with git log and git diff on that range.`
    : "The implementer's commits are the latest on this branch: find them with git log and read them with git diff.";
  return `You are a dispatched reviewer worker for Devia. You review; you do not build.

Review the work for kanban task ${taskId}. Read the task first with kanban_get_task for "${taskId}": it is the requirement the work must meet. ${range}

Check spec compliance first (every requirement and exact value of the task), then code quality and tests. Grade each finding Critical, Important or Minor, with file:line.

Rules:
- Do not modify files, do not commit and do not run formatters that rewrite files: you only read and run the project's checks.
${COMMON_RULES}

${REPORT_CONTRACT}
Use DONE when there is no Critical or Important finding; DONE_WITH_CONCERNS when there are, listing them under Critical / Important / Minor after the three sentences.`;
}
