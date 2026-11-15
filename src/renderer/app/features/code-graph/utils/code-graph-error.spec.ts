import { describe, expect, it } from 'vitest';

import { describeCodeGraphError } from './code-graph-error';

describe('describeCodeGraphError', () => {
  it('is null when there is no error', () => {
    expect(describeCodeGraphError(null)).toBeNull();
  });

  it('maps the domain codes to their own translated message, with no raw detail', () => {
    expect(describeCodeGraphError('CODE_GRAPH_NOT_CREATED')).toEqual({ key: 'codeGraph.errors.not_created', detail: null });
    expect(describeCodeGraphError('CODE_GRAPH_WATCH_LIMIT')).toEqual({ key: 'codeGraph.errors.watch_limit', detail: null });
  });

  it('hides the generic main-process failure behind the translated message', () => {
    const raw = "Error invoking remote method 'code-graph:index': Error: Code graph operation failed";
    expect(describeCodeGraphError(raw)).toEqual({ key: 'codeGraph.errors.action', detail: null });
  });

  it('strips the Electron IPC wrapper from any other message and keeps it as detail', () => {
    const raw = "Error invoking remote method 'code-graph:status': InvalidArgumentError: project must be a non-empty string";
    expect(describeCodeGraphError(raw)).toEqual({
      key: 'codeGraph.errors.action',
      detail: 'project must be a non-empty string',
    });
  });

  it('keeps an unwrapped message as detail', () => {
    expect(describeCodeGraphError('Workspace not configured')).toEqual({
      key: 'codeGraph.errors.action',
      detail: 'Workspace not configured',
    });
  });
});
