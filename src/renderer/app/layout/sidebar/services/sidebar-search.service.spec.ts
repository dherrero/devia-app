import { describe, it, expect, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { SidebarSearchService } from './sidebar-search.service';
import { ElectronApiService } from '../../../core/services/electron-api.service';
import type { ProjectEntry } from '../../../../types/devia';

function makeProject(path: string): ProjectEntry {
  return {
    path,
    name: path.split('/').pop() ?? path,
    isRunning: false,
    tech: 'folder',
  };
}

class DeferredApi {
  pending: Array<{
    query: string;
    resolve: (results: ProjectEntry[]) => void;
    reject: (err: unknown) => void;
  }> = [];

  searchProjects(query: string): Promise<ProjectEntry[]> {
    return new Promise((resolve, reject) => {
      this.pending.push({ query, resolve, reject });
    });
  }
}

function setup(): { svc: SidebarSearchService; api: DeferredApi } {
  const api = new DeferredApi();
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      SidebarSearchService,
      { provide: ElectronApiService, useValue: api },
    ],
  });
  return { svc: TestBed.inject(SidebarSearchService), api };
}

describe('SidebarSearchService (HT-SB-03)', () => {
  it('starts empty with no results and not searching', () => {
    const { svc } = setup();
    expect(svc.query()).toBe('');
    expect(svc.searching()).toBe(false);
    expect(svc.results()).toEqual([]);
  });

  it('does not IPC on an empty / blank query', () => {
    const { svc, api } = setup();
    svc.setQuery('');
    svc.setQuery('   ');
    expect(api.pending.length).toBe(0);
    expect(svc.searching()).toBe(false);
  });

  it('fires the IPC immediately on setQuery (debounce now lives in ds-search-box)', () => {
    const { svc, api } = setup();
    svc.setQuery('hello');
    expect(api.pending.length).toBe(1);
    expect(api.pending[0].query).toBe('hello');
    expect(svc.searching()).toBe(true);
    expect(svc.query()).toBe('hello');
  });

  it('discards late responses for stale tokens (race protection)', async () => {
    const { svc, api } = setup();
    svc.setQuery('a');
    const slow = api.pending[0];

    svc.setQuery('abc');
    const fast = api.pending[1];

    fast.resolve([makeProject('/ws/abc')]);
    await Promise.resolve();
    await Promise.resolve();
    expect(svc.results().map((p) => p.path)).toEqual(['/ws/abc']);
    expect(svc.searching()).toBe(false);

    // The late stale response must NOT overwrite the fresh results.
    slow.resolve([makeProject('/ws/a1')]);
    await Promise.resolve();
    await Promise.resolve();
    expect(svc.results().map((p) => p.path)).toEqual(['/ws/abc']);
  });

  it('clears results immediately when an empty query lands', async () => {
    const { svc, api } = setup();
    svc.setQuery('foo');
    api.pending[0].resolve([makeProject('/ws/foo')]);
    await Promise.resolve();
    await Promise.resolve();
    expect(svc.results().length).toBe(1);

    svc.setQuery('');
    expect(svc.query()).toBe('');
    expect(svc.results()).toEqual([]);
    expect(svc.searching()).toBe(false);
  });

  it('clear() is a shortcut for setQuery("")', () => {
    const { svc } = setup();
    svc.setQuery('foo');
    svc.clear();
    expect(svc.query()).toBe('');
    expect(svc.results()).toEqual([]);
  });

  it('treats IPC failures as empty results without throwing', async () => {
    const { svc, api } = setup();
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {
      /* swallow */
    });
    svc.setQuery('boom');
    api.pending[0].reject(new Error('main blew up'));
    await Promise.resolve();
    await Promise.resolve();
    expect(svc.results()).toEqual([]);
    expect(svc.searching()).toBe(false);
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('is a no-op when the same query lands twice in a row', () => {
    const { svc, api } = setup();
    svc.setQuery('hello');
    svc.setQuery('hello');
    expect(api.pending.length).toBe(1);
  });
});
