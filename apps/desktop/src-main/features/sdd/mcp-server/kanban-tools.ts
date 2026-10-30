import { isKanbanColumn } from '../../../../shared/domain/kanban';
import type { KanbanUseCase } from '../kanban/application/kanban.use-case';
import type { KanbanStore } from '../kanban/infrastructure/kanban-store';

/**
 * devia-kanban MCP tool surface (E-DSK-12 T5).
 *
 * Definitions (`KANBAN_TOOLS`) are advertised via `tools/list`;
 * `callKanbanTool` executes one against the shared JSON board. The
 * server process owns no hooks — it just mutates `kanban.json`; the
 * app's KanbanWatcher reflects the change into the UI and the board
 * reconciler raises notifications.
 */

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const COLUMN_ENUM = ['backlog', 'todo', 'in_progress', 'done'];
/** All columns, for read-only filters (includes `blocked`). */
const COLUMN_ENUM_FULL = ['backlog', 'todo', 'in_progress', 'blocked', 'done'];

export const KANBAN_TOOLS: McpToolDef[] = [
  {
    name: 'kanban_create_spec',
    description: 'Create a spec (a theme/feature grouping tasks). Returns its id (S-n).',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short spec title.' },
        description: { type: 'string', description: 'Optional longer description.' },
      },
      required: ['title'],
    },
  },
  {
    name: 'kanban_create_task',
    description: 'Create a task under a spec. Returns its id (T-n).',
    inputSchema: {
      type: 'object',
      properties: {
        specId: { type: 'string', description: 'Spec id (S-n) the task belongs to.' },
        title: { type: 'string', description: 'Short task title.' },
        body: { type: 'string', description: 'Actionable description / acceptance.' },
        dependsOn: {
          type: 'array',
          items: { type: 'string' },
          description: 'Task ids (T-n) that must finish first.',
        },
        column: {
          type: 'string',
          enum: ['backlog', 'todo'],
          description: 'todo = ready to work, backlog = later/uncertain. Default backlog.',
        },
      },
      required: ['specId', 'title'],
    },
  },
  {
    name: 'kanban_list',
    description:
      'List the board: spec summaries + a paginated page of task cards (no body). Filter by `specId`/`column`; page with `limit`/`offset` (response has `total`+`hasMore`). `verbose:true` adds bodies. Archived excluded unless `includeArchived`.',
    inputSchema: {
      type: 'object',
      properties: {
        specId: { type: 'string', description: 'Only tasks in this spec (S-n).' },
        column: { type: 'string', enum: COLUMN_ENUM_FULL, description: 'Only tasks in this column.' },
        includeArchived: { type: 'boolean', description: 'Include archived specs and their tasks. Default false.' },
        verbose: { type: 'boolean', description: 'Include each task body. Default false (cards only).' },
        limit: { type: 'number', description: 'Max tasks per page. Default 30.' },
        offset: { type: 'number', description: 'Task pagination offset. Default 0.' },
      },
    },
  },
  {
    name: 'kanban_list_specs',
    description:
      'List specs only: id, title, archived flag, per-column task counts (no tasks/bodies). Cheapest "what specs exist?" query. Archived excluded unless `includeArchived`.',
    inputSchema: {
      type: 'object',
      properties: {
        includeArchived: { type: 'boolean', description: 'Include archived specs. Default false.' },
      },
    },
  },
  {
    name: 'kanban_get_task',
    description: 'Return one task in detail, including its thread and sub-agent log.',
    inputSchema: {
      type: 'object',
      properties: { taskId: { type: 'string' } },
      required: ['taskId'],
    },
  },
  {
    name: 'kanban_update_task',
    description:
      'Edit a task; omitted fields are left untouched. Editing `dependsOn` re-evaluates the block state (clearing the last unmet dep unblocks; adding an unmet one blocks).',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task id (T-n) to edit.' },
        title: { type: 'string' },
        body: { type: 'string' },
        specId: { type: 'string', description: 'Reassign the task to another spec (S-n).' },
        dependsOn: {
          type: 'array',
          items: { type: 'string' },
          description: 'Full replacement set of dependency task ids (T-n). Pass [] to clear all.',
        },
      },
      required: ['taskId'],
    },
  },
  {
    name: 'kanban_archive_spec',
    description:
      'Archive (logical-delete) a spec: hidden from the board/lists, kept on disk, reopenable. Refused if the spec has open (non-done) tasks unless `force: true`.',
    inputSchema: {
      type: 'object',
      properties: {
        specId: { type: 'string', description: 'Spec id (S-n) to archive.' },
        force: { type: 'boolean', description: 'Archive even if some tasks are still open. Default false.' },
      },
      required: ['specId'],
    },
  },
  {
    name: 'kanban_reopen_spec',
    description: 'Reverse kanban_archive_spec — the spec reappears in the board and the listing tools.',
    inputSchema: {
      type: 'object',
      properties: { specId: { type: 'string', description: 'Spec id (S-n) to reopen.' } },
      required: ['specId'],
    },
  },
  {
    name: 'kanban_move_task',
    description: 'Move a task to a column: backlog | todo | in_progress | done.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        column: { type: 'string', enum: COLUMN_ENUM },
      },
      required: ['taskId', 'column'],
    },
  },
  {
    name: 'kanban_comment',
    description: 'Post a progress note to a task thread (the user sees it live).',
    inputSchema: {
      type: 'object',
      properties: { taskId: { type: 'string' }, body: { type: 'string' } },
      required: ['taskId', 'body'],
    },
  },
  {
    name: 'kanban_request_user_input',
    description:
      'Block a task and ask the user a question. It stays blocked until the user replies — stop working on it after calling this.',
    inputSchema: {
      type: 'object',
      properties: { taskId: { type: 'string' }, question: { type: 'string' } },
      required: ['taskId', 'question'],
    },
  },
  {
    name: 'kanban_record_subagent',
    description: 'Log that you delegated this task to a named sub-agent.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        subagentName: { type: 'string' },
        summary: { type: 'string' },
      },
      required: ['taskId', 'subagentName'],
    },
  },
  {
    name: 'kanban_close_task',
    description: 'Mark a task done, optionally linking the closing commit sha.',
    inputSchema: {
      type: 'object',
      properties: { taskId: { type: 'string' }, commit: { type: 'string' } },
      required: ['taskId'],
    },
  },
];

/**
 * Tools advertised on an EMPTY board (S-16 T-188). The other 11 list/mutate
 * tools are useless until a board exists, so on a project that has never used
 * the kanban they only bloat the cached prompt prefix (~2k tokens every turn).
 * Advertising just the two bootstrap tools lets the agent still START a board;
 * the full surface returns automatically on the next run once a spec/task
 * exists. `callKanbanTool` always dispatches the full set, so nothing is lost.
 */
const BOOTSTRAP_KANBAN_TOOL_NAMES = ['kanban_create_spec', 'kanban_create_task'];

export function advertisedKanbanTools(boardIsEmpty: boolean): McpToolDef[] {
  if (!boardIsEmpty) return KANBAN_TOOLS;
  const keep = new Set(BOOTSTRAP_KANBAN_TOOL_NAMES);
  return KANBAN_TOOLS.filter((t) => keep.has(t.name));
}

type Args = Record<string, unknown>;

function str(args: Args, key: string): string {
  const v = args[key];
  if (typeof v !== 'string') throw new Error(`Missing/invalid string argument "${key}"`);
  return v;
}

function optStr(args: Args, key: string): string | undefined {
  const v = args[key];
  return typeof v === 'string' ? v : undefined;
}

function optNum(args: Args, key: string): number | undefined {
  const v = args[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function optBool(args: Args, key: string): boolean | undefined {
  const v = args[key];
  return typeof v === 'boolean' ? v : undefined;
}

function strArr(args: Args, key: string): string[] | undefined {
  const v = args[key];
  if (!Array.isArray(v)) return undefined;
  return v.filter((d): d is string => typeof d === 'string');
}

/**
 * Execute one tool call. Returns the text payload for the
 * `tools/call` result. Throws on validation / not-found so the server
 * can wrap it as `isError`.
 */
export function callKanbanTool(
  deps: { useCase: KanbanUseCase; store: KanbanStore; projectPath: string },
  name: string,
  rawArgs: unknown,
): string {
  const { useCase, store, projectPath } = deps;
  const args: Args = rawArgs && typeof rawArgs === 'object' ? (rawArgs as Args) : {};

  switch (name) {
    case 'kanban_create_spec': {
      const spec = useCase.createSpec(projectPath, str(args, 'title'), optStr(args, 'description') ?? '');
      return `Created spec ${spec.id} "${spec.title}".`;
    }
    case 'kanban_create_task': {
      const deps2 = Array.isArray(args['dependsOn'])
        ? (args['dependsOn'] as unknown[]).filter((d): d is string => typeof d === 'string')
        : [];
      const col = optStr(args, 'column');
      const task = useCase.createTask(
        projectPath,
        str(args, 'specId'),
        str(args, 'title'),
        optStr(args, 'body') ?? '',
        deps2,
        col === 'todo' || col === 'backlog' ? { column: col } : {},
      );
      return `Created task ${task.id} "${task.title}" in ${task.column}.`;
    }
    case 'kanban_list': {
      const specId = optStr(args, 'specId');
      const column = optStr(args, 'column');
      const includeArchived = optBool(args, 'includeArchived');
      const verbose = optBool(args, 'verbose');
      const limit = optNum(args, 'limit');
      const offset = optNum(args, 'offset');
      if (column !== undefined && !isKanbanColumn(column)) {
        throw new Error(`Invalid column "${column}"`);
      }
      const result = store.listBoard(projectPath, {
        ...(specId !== undefined && { specId }),
        ...(column !== undefined && { column }),
        ...(includeArchived !== undefined && { includeArchived }),
        ...(verbose !== undefined && { verbose }),
        ...(limit !== undefined && { limit }),
        ...(offset !== undefined && { offset }),
      });
      return JSON.stringify(result, null, 2);
    }
    case 'kanban_list_specs': {
      const includeArchived = optBool(args, 'includeArchived');
      const summaries = store.specSummaries(
        projectPath,
        includeArchived !== undefined ? { includeArchived } : {},
      );
      return JSON.stringify(summaries, null, 2);
    }
    case 'kanban_get_task': {
      const view = store.taskView(projectPath, str(args, 'taskId'));
      if (!view) throw new Error(`Task ${str(args, 'taskId')} not found`);
      return JSON.stringify(view, null, 2);
    }
    case 'kanban_update_task': {
      const taskId = str(args, 'taskId');
      const title = optStr(args, 'title');
      const body = optStr(args, 'body');
      const specId = optStr(args, 'specId');
      const dependsOn = strArr(args, 'dependsOn');
      const fields: Parameters<KanbanUseCase['updateTask']>[2] = {
        ...(title !== undefined && { title }),
        ...(body !== undefined && { body }),
        ...(specId !== undefined && { specId }),
        ...(dependsOn !== undefined && { dependsOn }),
      };
      const task = useCase.updateTask(projectPath, taskId, fields);
      if (!task) throw new Error(`Task ${taskId} not found`);
      return `Updated ${task.id} (now in ${task.column}).`;
    }
    case 'kanban_archive_spec': {
      const specId = str(args, 'specId');
      const force = optBool(args, 'force') === true;
      const res = useCase.archiveSpec(projectPath, specId, { force });
      if (res.ok) return `Archived spec ${specId}.`;
      if (res.reason === 'not_found') throw new Error(`Spec ${specId} not found`);
      if (res.reason === 'already_archived') return `Spec ${specId} is already archived.`;
      throw new Error(
        `Spec ${specId} has ${res.openTasks} open task(s); pass force: true to archive anyway.`,
      );
    }
    case 'kanban_reopen_spec': {
      const specId = str(args, 'specId');
      if (!useCase.reopenSpec(projectPath, specId)) {
        throw new Error(`Spec ${specId} not found or not archived`);
      }
      return `Reopened spec ${specId}.`;
    }
    case 'kanban_move_task': {
      const column = str(args, 'column');
      if (!isKanbanColumn(column)) throw new Error(`Invalid column "${column}"`);
      const task = useCase.moveTask(projectPath, str(args, 'taskId'), column);
      if (!task) throw new Error(`Task ${str(args, 'taskId')} not found`);
      return `Moved ${task.id} to ${task.column}.`;
    }
    case 'kanban_comment': {
      const task = useCase.comment(projectPath, str(args, 'taskId'), 'agent', str(args, 'body'));
      if (!task) throw new Error(`Task ${str(args, 'taskId')} not found`);
      return `Comment posted to ${task.id}.`;
    }
    case 'kanban_request_user_input': {
      const task = useCase.requestUserInput(projectPath, str(args, 'taskId'), str(args, 'question'));
      if (!task) throw new Error(`Task ${str(args, 'taskId')} not found`);
      return `Task ${task.id} is now blocked waiting for the user. Stop working on it until they reply.`;
    }
    case 'kanban_record_subagent': {
      const task = useCase.recordSubagentInvocation(
        projectPath,
        str(args, 'taskId'),
        str(args, 'subagentName'),
        optStr(args, 'summary') ?? '',
      );
      if (!task) throw new Error(`Task ${str(args, 'taskId')} not found`);
      return `Logged sub-agent ${optStr(args, 'subagentName')} on ${task.id}.`;
    }
    case 'kanban_close_task': {
      const task = useCase.closeTask(projectPath, str(args, 'taskId'), optStr(args, 'commit'));
      if (!task) throw new Error(`Task ${str(args, 'taskId')} not found`);
      return `Closed ${task.id}.`;
    }
    default:
      throw new Error(`Unknown tool "${name}"`);
  }
}
