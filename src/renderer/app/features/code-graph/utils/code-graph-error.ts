export interface CodeGraphErrorView {
  /** i18n key of the headline shown to the user. */
  key: string;
  /** Extra text from the main process worth showing, already unwrapped; null when the headline says it all. */
  detail: string | null;
}

const CODE_KEYS: Record<string, string> = {
  CODE_GRAPH_NOT_CREATED: 'codeGraph.errors.not_created',
  CODE_GRAPH_WATCH_LIMIT: 'codeGraph.errors.watch_limit',
};

/** The main process replaces every unexpected failure with this exact text (code-graph.ipc.ts `sanitize`). */
const GENERIC_FAILURE = 'Code graph operation failed';

const IPC_WRAPPER = /^Error invoking remote method '[^']*':\s*/;
const ERROR_NAME_PREFIX = /^[A-Za-z]*Error:\s*/;

export function describeCodeGraphError(raw: string | null): CodeGraphErrorView | null {
  if (raw === null) return null;
  const code = Object.keys(CODE_KEYS).find((c) => raw.includes(c));
  if (code) return { key: CODE_KEYS[code] ?? 'codeGraph.errors.action', detail: null };
  const text = raw.replace(IPC_WRAPPER, '').replace(ERROR_NAME_PREFIX, '').trim();
  return { key: 'codeGraph.errors.action', detail: text === '' || text === GENERIC_FAILURE ? null : text };
}
