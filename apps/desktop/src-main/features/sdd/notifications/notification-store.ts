import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { SddNotification, SddNotificationKind } from '../../../../shared/domain/sdd';

/**
 * Persisted SDD notification centre (E-DSK-12 T7).
 *
 * One JSON file for all projects at `<deviaDir>/sdd-notifications.json`,
 * written atomically. Each entry carries its `projectPath` so the
 * renderer can scope the badge to the active project or show a global
 * count.
 *
 * Dedup: an incoming notification identical to the newest UNREAD one
 * (same kind + taskId + project) within `DEDUP_WINDOW_MS` is dropped —
 * keeps a chatty agent from flooding the centre.
 */
const MAX_ENTRIES = 200;
const DEDUP_WINDOW_MS = 10_000;

export interface NewNotification {
  projectPath: string;
  kind: SddNotificationKind;
  taskId?: string;
  taskTitle?: string;
}

export class NotificationStore {
  private cache: SddNotification[] | null = null;

  constructor(private readonly deviaDir: () => string) {}

  private file(): string {
    return path.join(this.deviaDir(), 'sdd-notifications.json');
  }

  private load(): SddNotification[] {
    if (this.cache) return this.cache;
    try {
      const raw = fs.readFileSync(this.file(), 'utf8');
      const parsed = JSON.parse(raw);
      this.cache = Array.isArray(parsed) ? parsed.filter(isNotification) : [];
    } catch {
      this.cache = [];
    }
    return this.cache;
  }

  private save(list: SddNotification[]): void {
    this.cache = list;
    const file = this.file();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  }

  /** Add a notification. Returns it, or null when deduplicated. */
  add(input: NewNotification): SddNotification | null {
    const list = this.load();
    const now = Date.now();
    const dup = list.find(
      (n) =>
        !n.read &&
        n.projectPath === input.projectPath &&
        n.kind === input.kind &&
        n.taskId === input.taskId &&
        now - n.createdAt < DEDUP_WINDOW_MS,
    );
    if (dup) return null;

    const notification: SddNotification = {
      id: crypto.randomBytes(6).toString('hex'),
      projectPath: input.projectPath,
      kind: input.kind,
      ...(input.taskId !== undefined && { taskId: input.taskId }),
      ...(input.taskTitle !== undefined && { taskTitle: input.taskTitle }),
      createdAt: now,
      read: false,
    };
    const next = [notification, ...list].slice(0, MAX_ENTRIES);
    this.save(next);
    return notification;
  }

  /** Notifications, newest first. Scoped to `projectPath` when given. */
  list(projectPath?: string): SddNotification[] {
    const all = this.load();
    return projectPath ? all.filter((n) => n.projectPath === projectPath) : all;
  }

  unreadTotal(projectPath?: string): number {
    return this.list(projectPath).filter((n) => !n.read).length;
  }

  /** Mark notifications read. Scope to a project, or all when omitted. */
  markRead(projectPath?: string): void {
    const list = this.load();
    let changed = false;
    for (const n of list) {
      if (projectPath && n.projectPath !== projectPath) continue;
      if (!n.read) { n.read = true; changed = true; }
    }
    if (changed) this.save(list);
  }

  /** Remove notifications. Scope to a project, or all when omitted. */
  clear(projectPath?: string): void {
    const list = this.load();
    const next = projectPath ? list.filter((n) => n.projectPath !== projectPath) : [];
    this.save(next);
  }
}

function isNotification(v: unknown): v is SddNotification {
  return (
    v !== null &&
    typeof v === 'object' &&
    typeof (v as SddNotification).id === 'string' &&
    typeof (v as SddNotification).projectPath === 'string'
  );
}
