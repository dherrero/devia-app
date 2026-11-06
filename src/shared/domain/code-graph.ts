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
}

export interface IndexProgress {
  phase: 'discover' | 'parse' | 'resolve' | 'finalize';
  filesDone: number;
  filesTotal: number;
  nodes: number;
  edges: number;
}

export interface GraphOverviewNode {
  id: string;
  kind: NodeKind | 'dir';
  label: string;
  childCount: number;
  community?: number;
  hub?: boolean;
}

export const GRAPH_PAGE_LIMIT = 2000;
export const GRAPH_EXPAND_LIMIT = 500;

export function isCodeGraphLanguage(v: string): v is CodeGraphLanguage {
  return (CODE_GRAPH_LANGUAGES as readonly string[]).includes(v);
}

export function isNodeKind(v: string): v is NodeKind {
  return (NODE_KINDS as readonly string[]).includes(v);
}

export function isEdgeKind(v: string): v is EdgeKind {
  return (EDGE_KINDS as readonly string[]).includes(v);
}
