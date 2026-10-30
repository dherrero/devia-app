import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { NotificationStore } from './notification-store';

describe('NotificationStore (T7)', () => {
  let dir: string;
  let store: NotificationStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devia-notif-'));
    store = new NotificationStore(() => dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('adds and lists notifications newest-first', () => {
    store.add({ projectPath: 'a', kind: 'task_done', taskId: 'T-1', taskTitle: 'one' });
    store.add({ projectPath: 'a', kind: 'task_done', taskId: 'T-2', taskTitle: 'two' });
    const list = store.list('a');
    expect(list).toHaveLength(2);
    expect(list[0]?.taskTitle).toBe('two');
  });

  it('deduplicates an identical unread notification within the window', () => {
    const first = store.add({ projectPath: 'a', kind: 'user_input', taskId: 'T-1', taskTitle: 'q' });
    const dup = store.add({ projectPath: 'a', kind: 'user_input', taskId: 'T-1', taskTitle: 'q' });
    expect(first).not.toBeNull();
    expect(dup).toBeNull();
    expect(store.list('a')).toHaveLength(1);
  });

  it('scopes list + unread count by project', () => {
    store.add({ projectPath: 'a', kind: 'task_done', taskId: 'T-1' });
    store.add({ projectPath: 'b', kind: 'task_done', taskId: 'T-1' });
    expect(store.list('a')).toHaveLength(1);
    expect(store.unreadTotal()).toBe(2);
    expect(store.unreadTotal('a')).toBe(1);
  });

  it('markRead and clear honour the project scope', () => {
    store.add({ projectPath: 'a', kind: 'task_done', taskId: 'T-1' });
    store.add({ projectPath: 'b', kind: 'task_done', taskId: 'T-1' });
    store.markRead('a');
    expect(store.unreadTotal('a')).toBe(0);
    expect(store.unreadTotal('b')).toBe(1);
    store.clear('b');
    expect(store.list()).toHaveLength(1);
  });

  it('persists across instances', () => {
    store.add({ projectPath: 'a', kind: 'task_done', taskId: 'T-1', taskTitle: 'persist' });
    const reopened = new NotificationStore(() => dir);
    expect(reopened.list('a')).toHaveLength(1);
  });
});
