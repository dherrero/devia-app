export const CODE_GRAPH_LANGUAGES = [
  'typescript',
  'javascript',
  'python',
  'java',
  'go',
  'dart',
] as const;
export type CodeGraphLanguage = (typeof CODE_GRAPH_LANGUAGES)[number];

export const NODE_KINDS = [
  'file',
  'module',
  'class',
  'interface',
  'enum',
  'enum_member',
  'function',
  'method',
  'property',
  'field',
  'variable',
  'constant',
  'type_alias',
  'namespace',
  'parameter',
  'import',
  'export',
  'component',
  'route',
] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

export const EDGE_KINDS = [
  'contains',
  'calls',
  'imports',
  'exports',
  'extends',
  'implements',
  'references',
  'type_of',
  'returns',
  'instantiates',
  'overrides',
  'decorates',
] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];

export type RefMetadata = Record<string, string | boolean>;

export interface GraphNode {
  id: string;
  kind: NodeKind;
  name: string;
  qualifiedName: string;
  filePath: string;
  language: CodeGraphLanguage;
  startLine: number;
  endLine: number;
  signature?: string;
  docstring?: string;
  isExported: boolean;
  isTest?: boolean;
  visibility?: 'public' | 'protected' | 'private' | 'package';
  isAsync?: boolean;
  isStatic?: boolean;
  isAbstract?: boolean;
  decorators?: string[];
  metadata?: RefMetadata;
}

export interface GraphEdge {
  source: string;
  target: string;
  kind: EdgeKind;
  line?: number;
  provenance?: 'static' | 'heuristic';
}

export interface CodeGraphStatus {
  state: 'none' | 'indexing' | 'ready' | 'stale' | 'error';
  nodeCount: number;
  edgeCount: number;
  fileCount: number;
  languages: Partial<Record<CodeGraphLanguage, number>>;
  builtAtCommit?: string;
  indexedAt?: number;
  agentAccess: boolean;
  autoUpdate: boolean;
  unsupported?: boolean;
  staleReason?: 'commit' | 'config' | 'dirty';
  /** The file watcher could not cover the whole tree or reported an error; live updates may be missed. */
  watchDegraded?: boolean;
}

export interface IndexProgress {
  phase: 'discover' | 'parse' | 'resolve' | 'finalize';
  filesDone: number;
  filesTotal: number;
  nodes: number;
  edges: number;
}

/**
 * A node of the graph view. Directories are virtual (`dir:<root-relative path>`);
 * files and symbols use their real `GraphNode.id`.
 */
export interface GraphOverviewNode {
  id: string;
  kind: NodeKind | 'dir';
  label: string;
  childCount: number;
  community?: number;
  hub?: boolean;
  /** Root-relative `/` path: the directory itself, or the file a file/symbol lives in. */
  path: string;
  /** Absent for the entries at the project root. */
  parentId?: string;
  language?: CodeGraphLanguage;
  symbolCount?: number;
  fileCount?: number;
  isTest?: boolean;
  exported?: boolean;
  line?: number;
}

export interface GraphViewEdge {
  source: string;
  target: string;
  kind: EdgeKind | 'aggregate';
  /** Number of real edges folded into this one. */
  weight: number;
}

export interface GraphViewPage {
  nodes: GraphOverviewNode[];
  /** At most GRAPH_EDGE_LIMIT, heaviest first when cut. */
  edges: GraphViewEdge[];
  total: number;
  hasMore: boolean;
  /** Set when edges beyond GRAPH_EDGE_LIMIT were left out. */
  edgesTruncated?: boolean;
}

export interface GraphOverviewOptions {
  /** Root entries to skip, for the root entries past the first page. */
  offset?: number;
}

export interface GraphExpandOptions {
  offset?: number;
  /** Ids already on screen; edges of the new children are mapped onto their nearest visible node. */
  visibleIds: string[];
}

export interface GraphImpactSummary {
  /** Impacted files in impact order (the node's own file first). */
  files: string[];
  /** Number of impacted files before the list was capped. */
  count: number;
  truncated: boolean;
}

export interface GraphFileRef {
  id: string;
  path: string;
}

export interface GraphSymbolDetail {
  kind: 'symbol';
  node: GraphNode;
  /** Ids to expand, in order, to reveal the node: its directories, its file, then its enclosing symbols. */
  ancestors: string[];
  callers: GraphNode[];
  callees: GraphNode[];
  impact: GraphImpactSummary;
  community?: number;
  hub?: boolean;
  signature?: string;
  docstring?: string;
}

export interface GraphFileDetail {
  kind: 'file';
  node: GraphNode;
  path: string;
  language: CodeGraphLanguage;
  ancestors: string[];
  symbolCount: number;
  importedBy: GraphFileRef[];
  importedByCount: number;
  imports: GraphFileRef[];
  importsCount: number;
  community?: number;
  isTest?: boolean;
}

export interface GraphDirDetail {
  kind: 'dir';
  id: string;
  path: string;
  ancestors: string[];
  fileCount: number;
  symbolCount: number;
  /** Files per language. */
  languages: Partial<Record<CodeGraphLanguage, number>>;
  topHubs: GraphNode[];
  /** Files per community, largest first. */
  communities: { id: number; files: number }[];
}

export type GraphNodeDetail = GraphSymbolDetail | GraphFileDetail | GraphDirDetail;

export interface GraphSearchResult {
  node: GraphOverviewNode;
  ancestors: string[];
  score: number;
}

export const GRAPH_PAGE_LIMIT = 2000;
export const GRAPH_EXPAND_LIMIT = 500;
export const GRAPH_EDGE_LIMIT = 5000;

export function isCodeGraphLanguage(v: string): v is CodeGraphLanguage {
  return (CODE_GRAPH_LANGUAGES as readonly string[]).includes(v);
}

export function isNodeKind(v: string): v is NodeKind {
  return (NODE_KINDS as readonly string[]).includes(v);
}

export function isEdgeKind(v: string): v is EdgeKind {
  return (EDGE_KINDS as readonly string[]).includes(v);
}
