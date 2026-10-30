import type { MemoryStore } from '../infrastructure/memory-store';
import type { MemoryUseCase } from '../application/memory.use-case';
import type { MemoryObservationType, MemoryScope, MemorySearchHit } from '../../../../shared/domain/memory';
import { getEmbedder, semanticRankIndices } from './semantic-rerank';

/** Lexical candidate pool size fed to the optional semantic re-ranking (#317). */
const SEMANTIC_POOL = 40;

/**
 * Re-order lexical hits by semantic similarity to the query (E-DSK-13 #317,
 * approach A). Best-effort: a too-small pool, an empty query, or any embedder
 * failure leaves the lexical order untouched.
 */
async function maybeSemanticRerank(query: string, hits: MemorySearchHit[]): Promise<MemorySearchHit[]> {
  if (!query.trim() || hits.length < 2) return hits;
  try {
    const embed = await getEmbedder();
    const texts = hits.map((h) => `${h.observation.title}\n${h.observation.content}`);
    const order = await semanticRankIndices(query, texts, embed);
    return order.flatMap((i) => {
      const hit = hits[i];
      return hit ? [hit] : [];
    });
  } catch {
    return hits;
  }
}

// ── McpToolDef (mirrors kanban-tools.ts to avoid cross-feature imports) ───

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// ── tool definitions ──────────────────────────────────────────────────────

const SCOPE_ENUM = ['project', 'personal'];

const OBS_TYPE_ENUM = [
  'decision', 'architecture', 'bugfix', 'pattern',
  'config', 'discovery', 'learning', 'manual',
];

export const MEMORY_TOOLS: McpToolDef[] = [
  {
    name: 'mem_save',
    description:
      'Save an observation worth remembering (decision, bug fix, discovery, convention). Call proactively, do not wait to be asked.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short, searchable title.' },
        content: { type: 'string', description: 'Full observation content.' },
        type: { type: 'string', enum: OBS_TYPE_ENUM, description: 'Observation type.' },
        scope: { type: 'string', enum: SCOPE_ENUM, description: 'project (default) or personal.' },
        project: { type: 'string', description: 'Project label for filtering.' },
        topic_key: { type: 'string', description: 'Freeform topic group key.' },
        session_id: { type: 'string', description: 'Session id to associate this observation with.' },
      },
      required: ['title'],
    },
  },
  {
    name: 'mem_search',
    description:
      'Search past observations by natural-language query — use before starting work to find prior decisions and context.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search terms.' },
        type: { type: 'string', enum: OBS_TYPE_ENUM, description: 'Filter by observation type.' },
        project: { type: 'string', description: 'Filter by project label.' },
        scope: { type: 'string', enum: SCOPE_ENUM, description: 'project (default) or personal.' },
        limit: { type: 'number', description: 'Max results (default 20).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'mem_context',
    description:
      'Get recent session history and summaries. Call at session start to prime context.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Filter sessions by project label.' },
        scope: { type: 'string', enum: SCOPE_ENUM, description: 'project (default) or personal.' },
      },
    },
  },
  {
    name: 'mem_session_summary',
    description:
      'Save an end-of-session summary. MANDATORY before saying "done" or ending work.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Summary of what was accomplished.' },
        session_id: { type: 'string', description: 'Optional session id.' },
      },
      required: ['content'],
    },
  },
  {
    name: 'mem_get_observation',
    description: 'Get the full untruncated content of an observation by id.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Observation id (obs-N).' },
      },
      required: ['id'],
    },
  },
  {
    name: 'mem_save_prompt',
    description: 'Save a user prompt for future context and recall.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The prompt text.' },
        session_id: { type: 'string', description: 'Optional session id.' },
        project: { type: 'string', description: 'Optional project label.' },
      },
      required: ['content'],
    },
  },
  {
    name: 'mem_current_project',
    description: 'Detect the current project name from the working directory.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

// ── arg helpers ───────────────────────────────────────────────────────────

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
  return typeof v === 'number' ? v : undefined;
}

function toScope(v: string | undefined): MemoryScope | undefined {
  if (v === 'project' || v === 'personal') return v;
  return undefined;
}

function toObsType(v: string | undefined): MemoryObservationType | undefined {
  const VALID = new Set(OBS_TYPE_ENUM);
  if (v !== undefined && VALID.has(v)) return v as MemoryObservationType;
  return undefined;
}

// ── dispatcher ────────────────────────────────────────────────────────────

export interface MemoryToolDeps {
  useCase: MemoryUseCase;
  store: MemoryStore;
  projectPath: string;
  /** Active CLI agent id (from DEVIA_ACTIVE_AGENT_ID) — stamped on writes (S-2 F1.1). */
  agentId?: string;
}

/**
 * Execute one `mem_*` tool call.
 *
 * Returns a UTF-8 text string for the MCP `tools/call` content array.
 * Throws on validation errors or unknown tool names — the server wraps
 * them as `isError: true`.
 */
export function callMemoryTool(
  deps: MemoryToolDeps,
  name: string,
  rawArgs: unknown,
): string | Promise<string> {
  const { useCase, projectPath, agentId } = deps;
  const args: Args = rawArgs && typeof rawArgs === 'object' ? (rawArgs as Args) : {};

  switch (name) {
    case 'mem_save': {
      const saveType = toObsType(optStr(args, 'type'));
      const saveProject = optStr(args, 'project');
      const saveTopic = optStr(args, 'topic_key');
      const saveSession = optStr(args, 'session_id');
      const obs = useCase.save({
        title: str(args, 'title'),
        content: optStr(args, 'content') ?? '',
        scope: toScope(optStr(args, 'scope')) ?? 'project',
        ...(saveType !== undefined && { type: saveType }),
        ...(saveProject !== undefined && { project: saveProject }),
        ...(saveTopic !== undefined && { topicKey: saveTopic }),
        ...(saveSession !== undefined && { sessionId: saveSession }),
        ...(agentId !== undefined && { agentId }),
        toolName: 'mem_save',
        projectPath,
      });
      return `Saved observation ${obs.id}: "${obs.title}".`;
    }

    case 'mem_search': {
      const searchType = toObsType(optStr(args, 'type'));
      const searchProject = optStr(args, 'project');
      const requested = optNum(args, 'limit') ?? 20;
      // Fetch a larger lexical candidate pool, semantically re-rank it, then
      // trim to the requested limit (E-DSK-13 #317).
      const query = str(args, 'query');
      const pool = useCase.search(query, {
        scope: toScope(optStr(args, 'scope')) ?? 'project',
        ...(searchType !== undefined && { type: searchType }),
        ...(searchProject !== undefined && { project: searchProject }),
        limit: Math.max(requested, SEMANTIC_POOL),
        projectPath,
      });
      // Validation above is synchronous (throws before we return a Promise), so
      // missing-arg errors still surface synchronously to the caller. Only the
      // semantic re-rank is async.
      return maybeSemanticRerank(query, pool).then((reranked) =>
        JSON.stringify(
          reranked.slice(0, requested).map((h) => ({
            id: h.observation.id,
            score: h.score,
            title: h.observation.title,
            content: h.observation.content,
            type: h.observation.type,
            createdAt: h.observation.createdAt,
            updatedAt: h.observation.updatedAt,
          })),
          null,
          2,
        ),
      );
    }

    case 'mem_context': {
      const ctx = useCase.context({
        scope: toScope(optStr(args, 'scope')) ?? 'project',
        projectPath,
      });
      return JSON.stringify(ctx, null, 2);
    }

    case 'mem_session_summary': {
      const summarySession = optStr(args, 'session_id');
      const ses = useCase.sessionSummary({
        content: str(args, 'content'),
        scope: 'project',
        ...(summarySession !== undefined && { sessionId: summarySession }),
        ...(agentId !== undefined && { agentId }),
        projectPath,
      });
      return `Session summary saved (${ses.id}).`;
    }

    case 'mem_get_observation': {
      const obs = useCase.getObservation(str(args, 'id'), { scope: 'project', projectPath });
      if (!obs) {
        // Also try personal scope as a fallback.
        const personal = useCase.getObservation(str(args, 'id'), { scope: 'personal' });
        if (!personal) throw new Error(`Observation ${str(args, 'id')} not found`);
        return JSON.stringify(personal, null, 2);
      }
      return JSON.stringify(obs, null, 2);
    }

    case 'mem_save_prompt': {
      const promptSession = optStr(args, 'session_id');
      const promptProject = optStr(args, 'project');
      const prm = useCase.savePrompt({
        content: str(args, 'content'),
        scope: 'project',
        ...(promptSession !== undefined && { sessionId: promptSession }),
        ...(promptProject !== undefined && { project: promptProject }),
        ...(agentId !== undefined && { agentId }),
        projectPath,
      });
      return `Prompt saved (${prm.id}).`;
    }

    case 'mem_current_project': {
      const result = useCase.currentProject(projectPath);
      return JSON.stringify(result, null, 2);
    }

    default:
      throw new Error(`Unknown tool "${name}"`);
  }
}
