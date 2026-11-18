import { signal } from '@angular/core';
import { vi } from 'vitest';

import type { CodeGraphStatus, IndexProgress, ToolUsageSummary } from '../../../../../shared/domain/code-graph';

export function graphStatus(over: Partial<CodeGraphStatus> = {}): CodeGraphStatus {
  return {
    state: 'none',
    nodeCount: 0,
    edgeCount: 0,
    fileCount: 0,
    languages: {},
    agentAccess: true,
    autoUpdate: true,
    ...over,
  };
}

/** Stand-in for `CodeGraphStateService` in component specs: writable signals + spied actions. */
export function makeFakeGraphState() {
  return {
    status: signal<CodeGraphStatus | null>(null),
    progress: signal<IndexProgress | null>(null),
    loading: signal(false),
    busy: signal(false),
    error: signal<string | null>(null),
    project: signal<string | null>('proj-a'),
    watchUnavailable: signal(false),
    usage: signal<ToolUsageSummary | null>(null),
    refreshUsage: vi.fn(() => Promise.resolve()),
    open: vi.fn<(p: string) => Promise<void>>(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
    index: vi.fn(() => Promise.resolve()),
    update: vi.fn(() => Promise.resolve()),
    cancel: vi.fn(() => Promise.resolve()),
    reset: vi.fn(() => Promise.resolve()),
    setAgentAccess: vi.fn<(on: boolean) => Promise<void>>(() => Promise.resolve()),
    setAutoUpdate: vi.fn<(on: boolean) => Promise<void>>(() => Promise.resolve()),
    dismissError: vi.fn(),
  };
}

export type FakeGraphState = ReturnType<typeof makeFakeGraphState>;
