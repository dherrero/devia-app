import { describe, expect, it } from 'vitest';
import {
  EDGE_KINDS,
  GRAPH_EXPAND_LIMIT,
  GRAPH_PAGE_LIMIT,
  NODE_KINDS,
  isCodeGraphLanguage,
  isEdgeKind,
  isNodeKind,
} from './code-graph';

describe('code-graph guards', () => {
  it('isNodeKind accepts known kinds only', () => {
    expect(isNodeKind('method')).toBe(true);
    expect(isNodeKind('struct')).toBe(false);
  });

  it('isEdgeKind accepts known kinds only', () => {
    expect(isEdgeKind('calls')).toBe(true);
    expect(isEdgeKind('owns')).toBe(false);
  });

  it('isCodeGraphLanguage accepts supported languages only', () => {
    expect(isCodeGraphLanguage('dart')).toBe(true);
    expect(isCodeGraphLanguage('ruby')).toBe(false);
  });

  it('kind lists have no duplicates', () => {
    expect(new Set(NODE_KINDS).size).toBe(NODE_KINDS.length);
    expect(new Set(EDGE_KINDS).size).toBe(EDGE_KINDS.length);
  });

  it('expand limit does not exceed page limit', () => {
    expect(GRAPH_EXPAND_LIMIT).toBeLessThanOrEqual(GRAPH_PAGE_LIMIT);
  });
});
