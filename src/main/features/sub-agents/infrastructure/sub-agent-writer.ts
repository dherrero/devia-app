import * as fs from 'node:fs';
import * as path from 'node:path';

import type {
  SubAgent,
  SubAgentCliId,
} from '../../../../shared/domain/sub-agents';
import {
  resolveSubAgentTarget,
  type SubAgentTarget,
} from '../domain/agent-targets';
import { renderSubAgentFile } from './frontmatter';

/**
 * Per-CLI writer that materialises a Devia sub-agent into the
 * matching agent's native location (#275).
 *
 * Three strategies:
 *   - markdown-copy   → write `<dir>/<name>.md` with the unified
 *                       frontmatter + body. Used by Claude, Cursor,
 *                       Gemini.
 *   - json-merge      → upsert under `<jsonParentKey>.<name>` with
 *                       a `__devia_managed: <name>` marker for
 *                       idempotent updates. Used by OpenCode and
 *                       Copilot.
 *   - slash-command   → write a Qwen-specific markdown file at
 *                       `.qwen/commands/<name>.md` with the slash-
 *                       command frontmatter shape.
 *
 * All writes go through temp-file + rename so a crash in the middle
 * never leaves the target file half-written.
 */

export const DEVIA_MANAGED_KEY = '__devia_managed';

export interface WriteResult {
  /** Files the writer touched (created / updated). */
  affectedFiles: string[];
}

export class SubAgentWriter {
  /** Materialise the sub-agent into every selected CLI. */
  syncAll(sub: SubAgent, projectPath: string): WriteResult {
    const affected: string[] = [];
    for (const cli of sub.agents) {
      const target = resolveSubAgentTarget(cli, sub.name, projectPath);
      if (!target) continue; // codex → no-op (handled by use case)
      const touched = this.writeOne(sub, target, cli);
      affected.push(...touched);
    }
    return { affectedFiles: affected };
  }

  /** Remove the sub-agent from every CLI that previously hosted it. */
  removeAll(
    name: string,
    previousAgents: ReadonlyArray<SubAgentCliId>,
    projectPath: string,
  ): WriteResult {
    const affected: string[] = [];
    for (const cli of previousAgents) {
      const target = resolveSubAgentTarget(cli, name, projectPath);
      if (!target) continue;
      const touched = this.deleteOne(name, target);
      affected.push(...touched);
    }
    return { affectedFiles: affected };
  }

  /** Returns the list of files the writer WOULD touch — used by the
   *  install use case to capture them in a snapshot BEFORE writing. */
  pathsForSync(sub: SubAgent, projectPath: string): string[] {
    const out: string[] = [];
    for (const cli of sub.agents) {
      const target = resolveSubAgentTarget(cli, sub.name, projectPath);
      if (!target) continue;
      out.push(...this.pathsForTarget(target));
    }
    return out;
  }

  pathsForRemove(
    name: string,
    previousAgents: ReadonlyArray<SubAgentCliId>,
    projectPath: string,
  ): string[] {
    const out: string[] = [];
    for (const cli of previousAgents) {
      const target = resolveSubAgentTarget(cli, name, projectPath);
      if (!target) continue;
      out.push(...this.pathsForTarget(target));
    }
    return out;
  }

  // ─── strategies ───────────────────────────────────────────────

  private writeOne(sub: SubAgent, target: SubAgentTarget, cli: SubAgentCliId): string[] {
    switch (target.strategy) {
      case 'markdown-copy':
        return this.writeMarkdown(sub, target, cli);
      case 'json-merge':
        return this.writeJsonMerge(sub, target);
      case 'slash-command':
        return this.writeSlashCommand(sub, target);
    }
  }

  private deleteOne(name: string, target: SubAgentTarget): string[] {
    switch (target.strategy) {
      case 'markdown-copy':
      case 'slash-command':
        return this.deleteFile(target.file ?? '');
      case 'json-merge':
        return this.deleteJsonEntry(name, target);
    }
  }

  private writeMarkdown(sub: SubAgent, target: SubAgentTarget, cli: SubAgentCliId): string[] {
    if (!target.file || !target.dir) return [];
    fs.mkdirSync(target.dir, { recursive: true });

    // Cursor honours `readonly`; the others ignore it. Pass it through
    // so Cursor users get the same semantics they would have set by
    // hand. Gemini needs the companion settings flag.
    const fm = {
      name: sub.name,
      description: sub.description,
      tools: [...sub.tools],
      devia_managed: true,
      ...(sub.model !== undefined && { model: sub.model }),
      ...(sub.maxTurns !== undefined && { maxTurns: sub.maxTurns }),
      ...(cli === 'cursor-agent' && sub.readonly !== undefined && { readonly: sub.readonly }),
    };
    const body = renderSubAgentFile(fm, sub.body);
    writeAtomically(target.file, body);

    const touched = [target.file];
    if (cli === 'gemini' && target.companionFile) {
      const wrote = ensureGeminiExperimentalFlag(target.companionFile);
      if (wrote) touched.push(target.companionFile);
    }
    return touched;
  }

  private writeSlashCommand(sub: SubAgent, target: SubAgentTarget): string[] {
    if (!target.file || !target.dir) return [];
    fs.mkdirSync(target.dir, { recursive: true });
    // Qwen accepts the same `name + description` frontmatter and
    // treats the body as the slash command prompt. The user invokes
    // the sub-agent by typing `/<name>` from the chat.
    const fm = {
      name: sub.name,
      description: sub.description,
      tools: [...sub.tools],
      devia_managed: true,
    };
    const body = renderSubAgentFile(fm, sub.body);
    writeAtomically(target.file, body);
    return [target.file];
  }

  private writeJsonMerge(sub: SubAgent, target: SubAgentTarget): string[] {
    if (!target.jsonFile || !target.jsonParentKey) return [];
    const root = readJson(target.jsonFile) ?? {};
    const parent = (root[target.jsonParentKey] && typeof root[target.jsonParentKey] === 'object')
      ? { ...(root[target.jsonParentKey] as Record<string, unknown>) }
      : {};
    parent[sub.name] = {
      description: sub.description,
      prompt: sub.body,
      tools: [...sub.tools],
      ...(sub.model !== undefined && { model: sub.model }),
      [DEVIA_MANAGED_KEY]: sub.name,
    };
    root[target.jsonParentKey] = parent;
    writeAtomically(target.jsonFile, JSON.stringify(root, null, 2) + '\n');
    return [target.jsonFile];
  }

  private deleteFile(file: string): string[] {
    if (!file) return [];
    try { fs.rmSync(file, { force: true }); return [file]; }
    catch { return []; }
  }

  private deleteJsonEntry(name: string, target: SubAgentTarget): string[] {
    if (!target.jsonFile || !target.jsonParentKey) return [];
    const root = readJson(target.jsonFile);
    if (!root) return [];
    const parent = root[target.jsonParentKey];
    if (parent === null || typeof parent !== 'object') return [];
    const entry = (parent as Record<string, unknown>)[name];
    if (entry === null || typeof entry !== 'object') return [];
    const managedBy = (entry as Record<string, unknown>)[DEVIA_MANAGED_KEY];
    if (managedBy !== name && managedBy !== true) {
      // Hand-added entry — leave it alone.
      return [];
    }
    const next = { ...(parent as Record<string, unknown>) };
    delete next[name];
    if (Object.keys(next).length === 0) {
      delete (root as Record<string, unknown>)[target.jsonParentKey];
    } else {
      (root as Record<string, unknown>)[target.jsonParentKey] = next;
    }
    writeAtomically(target.jsonFile, JSON.stringify(root, null, 2) + '\n');
    return [target.jsonFile];
  }

  private pathsForTarget(target: SubAgentTarget): string[] {
    if (target.strategy === 'json-merge') {
      return target.jsonFile ? [target.jsonFile] : [];
    }
    return target.file ? [target.file] : [];
  }
}

// ─── helpers ──────────────────────────────────────────────────────

function readJson(file: string): Record<string, unknown> | null {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function writeAtomically(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, body, 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * Gemini's sub-agent support is gated by a settings flag. We flip
 * it once on first sync and leave it alone afterwards. Returns true
 * when the file was actually mutated so the caller can include it
 * in the affected-files list.
 */
function ensureGeminiExperimentalFlag(file: string): boolean {
  let root: Record<string, unknown> = {};
  let existed = false;
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      root = parsed as Record<string, unknown>;
      existed = true;
    }
  } catch { /* doesn't exist yet */ }

  const experimental = (root['experimental'] && typeof root['experimental'] === 'object')
    ? { ...(root['experimental'] as Record<string, unknown>) }
    : {};
  if (experimental['enableAgents'] === true) return false;
  experimental['enableAgents'] = true;
  root['experimental'] = experimental;
  writeAtomically(file, JSON.stringify(root, null, 2) + '\n');
  return existed || true;
}
