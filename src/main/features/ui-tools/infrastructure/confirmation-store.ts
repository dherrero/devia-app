import * as fs from 'node:fs';
import * as path from 'node:path';

import type { ConfirmationGrant } from '../../../../shared/domain/ui-tools';
import { projectKey } from '../../../shared/project-key';

export type { ConfirmationGrant };

/**
 * "Always allow" grants for `devia_confirm` (S-25 F2.4), per project.
 *
 * THE SECURITY DECISION HERE IS THE MATCHING RULE: a grant matches only by
 * EXACT equality of the normalised action. Never by prefix, never by pattern.
 * `rm -rf node_modules` must not silently authorise `rm -rf /`.
 *
 * Stored at `~/.devia-app/projects/<key>/ui-confirmations.json`, alongside the
 * memory and kanban stores, and keyed by the BASE checkout for the same reason
 * they are: a per-session worktree path would fragment the grants into one
 * orphan file per session (the S-1 lesson).
 */

interface StoreDoc {
  grants: ConfirmationGrant[];
}

/**
 * Case-folded and whitespace-collapsed, so `RM  -RF dist` and `rm -rf dist`
 * are the same grant. Nothing else is normalised away — every remaining
 * character is significant.
 */
export function normalizeAction(action: string): string {
  return action.trim().replace(/\s+/g, ' ').toLowerCase();
}

export class ConfirmationStore {
  constructor(private readonly deviaDir: () => string) {}

  fileFor(projectPath: string): string {
    return path.join(this.deviaDir(), 'projects', projectKey(projectPath), 'ui-confirmations.json');
  }

  list(projectPath: string): ConfirmationGrant[] {
    return this.load(projectPath).grants;
  }

  isGranted(projectPath: string, action: string): boolean {
    const key = normalizeAction(action);
    if (!key) return false;
    return this.load(projectPath).grants.some((g) => g.action === key);
  }

  grant(projectPath: string, action: string, agentId?: string): void {
    const key = normalizeAction(action);
    if (!key) return;
    const doc = this.load(projectPath);
    if (doc.grants.some((g) => g.action === key)) return;
    doc.grants.push({
      action: key,
      label: action.trim(),
      grantedAt: new Date().toISOString(),
      ...(agentId !== undefined && { agentId }),
    });
    this.save(projectPath, doc);
  }

  revoke(projectPath: string, action: string): void {
    const key = normalizeAction(action);
    const doc = this.load(projectPath);
    const next = doc.grants.filter((g) => g.action !== key);
    if (next.length === doc.grants.length) return;
    this.save(projectPath, { grants: next });
  }

  revokeAll(projectPath: string): void {
    this.save(projectPath, { grants: [] });
  }

  /**
   * Always reads from disk. There is no cache on purpose: this is a security
   * decision read at most once per tool call, and a stale "granted" would
   * auto-approve something the user just revoked.
   */
  private load(projectPath: string): StoreDoc {
    try {
      const raw = fs.readFileSync(this.fileFor(projectPath), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      const grants = (parsed as StoreDoc | null)?.grants;
      if (!Array.isArray(grants)) return { grants: [] };
      return { grants: grants.filter(isGrant) };
    } catch {
      return { grants: [] };
    }
  }

  private save(projectPath: string, doc: StoreDoc): void {
    const file = this.fileFor(projectPath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, file);
  }
}

function isGrant(value: unknown): value is ConfirmationGrant {
  const g = value as ConfirmationGrant | null;
  return (
    g !== null &&
    typeof g === 'object' &&
    typeof g.action === 'string' &&
    g.action.length > 0 &&
    typeof g.label === 'string'
  );
}
