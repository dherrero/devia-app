import {
  UI_TOOL_KIND,
  UI_TOOL_NAMES,
  uiToolFromPublicName,
  uiToolPublicName,
  type UiToolCatalogEntry,
  type UiToolKind,
  type UiToolName,
} from '../../../../shared/domain/ui-tools';

/**
 * The tool surface of the `devia-ui` MCP server (S-25).
 *
 * A definition is DATA — schema, description and blocking kind. The behaviour
 * is uniform and lives in `ui-tools-call.ts`: a blocking tool writes a request
 * and waits for the user; a fire-and-forget tool writes a signal and returns.
 * That uniformity is the whole point of collapsing eight would-be servers into
 * one.
 */

export interface UiToolDef {
  name: UiToolName;
  publicName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  kind: UiToolKind;
}

/** Shape advertised over `tools/list`. */
export interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const askUserSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      minItems: 1,
      description: 'One entry per question. Ask everything you need in a single call.',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Optional stable id for this question.' },
          header: { type: 'string', description: 'Short title shown above the question.' },
          question: { type: 'string', description: 'The question, as the user reads it.' },
          multiSelect: { type: 'boolean', description: 'Allow picking more than one option.' },
          options: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              properties: {
                label: { type: 'string', description: 'The option, as the user reads it.' },
                description: { type: 'string', description: 'Optional one-line rationale.' },
              },
              required: ['label'],
            },
          },
        },
        required: ['question', 'options'],
      },
    },
  },
  required: ['questions'],
};

const todoSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      minItems: 1,
      description: 'The COMPLETE step list. Always send every step, not a delta.',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          text: { type: 'string', description: 'The step, as the user reads it.' },
          status: { type: 'string', enum: ['pending', 'in_progress', 'done'] },
        },
        required: ['text'],
      },
    },
  },
  required: ['items'],
};

const planApproveSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'One-line summary of the plan.' },
    plan: { type: 'string', description: 'The plan itself, as markdown.' },
    risks: { type: 'string', description: 'What could go wrong, in one or two lines.' },
    filesTouched: { type: 'array', items: { type: 'string' } },
    steps: {
      type: 'array',
      items: { type: 'string' },
      description: 'The steps, in order. You will report progress on them with devia_todo.',
    },
  },
  required: ['plan'],
};

const requestReviewSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    intro: { type: 'string', description: 'What you changed and what to look at.' },
    paths: {
      type: 'array',
      items: { type: 'string' },
      description: 'Narrow the diff to these paths. Omit to review everything you changed.',
    },
  },
};

const confirmSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    action: { type: 'string', description: 'The exact action you are about to perform.' },
    detail: { type: 'string', description: 'Why it is needed and what it affects.' },
    danger: {
      type: 'boolean',
      description: 'True when the action is destructive or irreversible.',
    },
  },
  required: ['action'],
};

const pickSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    intro: { type: 'string', description: 'What the user is choosing and why.' },
    multiple: { type: 'boolean' },
    filter: { type: 'string', enum: ['file', 'dir', 'any'] },
    root: { type: 'string', description: 'Subdirectory to start from, relative to the project.' },
  },
};

const notifySchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    body: { type: 'string' },
    level: { type: 'string', enum: ['info', 'warn', 'error'] },
  },
  required: ['title'],
};

const skillSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    op: { type: 'string', enum: ['list', 'load'] },
    name: { type: 'string', description: 'Skill name. Required for `load`.' },
  },
  required: ['op'],
};

const sendFileSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    path: { type: 'string' },
    caption: { type: 'string' },
    as: { type: 'string', enum: ['auto', 'document', 'photo'] },
  },
  required: ['path'],
};

const DEFS: Record<UiToolName, Omit<UiToolDef, 'publicName' | 'kind'>> = {
  ask_user: {
    name: 'ask_user',
    description:
      'Ask the Devia user to pick between a few discrete options and WAIT for their choice. ' +
      'Renders as a clickable card in the Devia chat and blocks until the user answers, ' +
      'so the answer comes back within the same turn. ' +
      'Use it for decisions with a small closed set of alternatives. ' +
      'For open-ended clarifications, just ask in plain text in your reply instead.',
    inputSchema: askUserSchema,
  },
  todo: {
    name: 'todo',
    description:
      'Publish or update your step list so the user can follow your progress. ' +
      'Send the COMPLETE list every time — it replaces the previous one. ' +
      'Returns immediately; it never blocks and never asks anything.',
    inputSchema: todoSchema,
  },
  plan_approve: {
    name: 'plan_approve',
    description:
      'Submit your plan for the user to approve, and WAIT for their decision. ' +
      'Use it when you have finished planning, instead of starting to edit files. ' +
      'The user can keep planning (with a comment) or accept it: apply mode, with or without permission prompts.',
    inputSchema: planApproveSchema,
  },
  request_review: {
    name: 'request_review',
    description:
      'Ask the user to review your diff line by line and WAIT for their comments. ' +
      'Opens the Cambios view in Devia; the user comments on specific lines and those ' +
      'comments come back as the tool result. Use it after a non-trivial change.',
    inputSchema: requestReviewSchema,
  },
  confirm: {
    name: 'confirm',
    description:
      'Ask the user to confirm a destructive or irreversible action, and WAIT. ' +
      'Use it before mass deletions, force pushes, dropping data, or anything you cannot undo.',
    inputSchema: confirmSchema,
  },
  pick: {
    name: 'pick',
    description:
      'Ask the user to choose files or directories from the project tree, and WAIT. ' +
      'Use it instead of listing a dozen candidates in text and asking which one.',
    inputSchema: pickSchema,
  },
  notify: {
    name: 'notify',
    description:
      'Send the user a desktop (and Telegram, when connected) notification. ' +
      'Use it when a long run finishes or needs attention. Returns immediately.',
    inputSchema: notifySchema,
  },
  skill: {
    name: 'skill',
    description:
      'List the skills and sub-agents Devia manages for this project, or load one in full ' +
      '(a sub-agent loads as a role to take on). `op: "list"` first, then `op: "load"`.',
    inputSchema: skillSchema,
  },
  send_file: {
    name: 'send_file',
    description:
      "Send a file from the project to the user's Telegram chat. Delivered after your reply. " +
      'Use for screenshots, reports, exports the user asked for. ' +
      'Paths relative to the working directory. Max 50 MB; secrets are refused.',
    inputSchema: sendFileSchema,
  },
};

export const UI_TOOL_REGISTRY: Record<UiToolName, UiToolDef> = UI_TOOL_NAMES.reduce(
  (acc, name) => {
    acc[name] = {
      ...DEFS[name],
      publicName: uiToolPublicName(name),
      kind: UI_TOOL_KIND[name],
    };
    return acc;
  },
  {} as Record<UiToolName, UiToolDef>,
);

export function toMcpTool(def: UiToolDef): McpToolDescriptor {
  return { name: def.publicName, description: def.description, inputSchema: def.inputSchema };
}

/**
 * `tools/list` payload. The subset is decided by the RUNNER and delivered on
 * argv, never inferred here: the advertised set must be stable for the whole
 * run or the agent's cached prompt prefix changes mid-conversation.
 */
export function advertisedUiTools(enabled: readonly UiToolName[]): McpToolDescriptor[] {
  const seen = new Set<UiToolName>();
  const out: McpToolDescriptor[] = [];
  // Iterate the canonical order, not the caller's, so the same set always
  // serialises identically (a reordered `tools/list` would break the cache).
  for (const name of UI_TOOL_NAMES) {
    if (!enabled.includes(name) || seen.has(name)) continue;
    seen.add(name);
    out.push(toMcpTool(UI_TOOL_REGISTRY[name]));
  }
  return out;
}

/**
 * The catalog the settings panel renders, costs included. Measured against the
 * SAME serialisation `tools/list` sends, so the number the user sees is the
 * number they actually pay per turn.
 */
export function uiToolCatalog(): UiToolCatalogEntry[] {
  return UI_TOOL_NAMES.map((name) => {
    const def = UI_TOOL_REGISTRY[name];
    return {
      name,
      publicName: def.publicName,
      description: def.description,
      kind: def.kind,
      schemaChars: JSON.stringify(toMcpTool(def)).length,
    };
  });
}

/** Parse a `--tools a,b,c` argv value, dropping anything unknown. */
export function parseToolList(csv: string): UiToolName[] {
  const out: UiToolName[] = [];
  for (const raw of csv.split(',')) {
    const name = uiToolFromPublicName(raw.trim());
    if (name !== null && !out.includes(name)) out.push(name);
  }
  return out;
}
