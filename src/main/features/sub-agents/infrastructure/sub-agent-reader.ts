import * as fs from 'node:fs';
import * as path from 'node:path';

import type {
  SubAgent,
  SubAgentCliId,
  SubAgentView,
} from '../../../../shared/domain/sub-agents';
import { parseSubAgentFile } from './frontmatter';
import { importScanPaths } from '../domain/agent-targets';

/**
 * Reader for the per-project sub-agent catalog (#275).
 *
 * Devia owns `<project>/.devia/sub-agents/<name>.md`; that's the
 * source of truth. The reader also surfaces the native dirs
 * (`.claude/agents/`, `.cursor/agents/`, …) so auto-import can find
 * pre-existing sub-agents in cloned repos.
 */

export const DEVIA_DIR = '.devia';
export const SUB_AGENTS_SUBDIR = 'sub-agents';

export class SubAgentReader {
  private deviaSubAgentDir(projectPath: string): string {
    return path.join(projectPath, DEVIA_DIR, SUB_AGENTS_SUBDIR);
  }

  /** Returns the canonical sub-agent list for the project — only the
   *  files Devia owns. The auto-import step is what brings native
   *  files into this dir. */
  list(projectPath: string): SubAgentView[] {
    const dir = this.deviaSubAgentDir(projectPath);
    if (!safeIsDir(dir)) return [];

    const out: SubAgentView[] = [];
    for (const file of safeReaddir(dir)) {
      if (!file.endsWith('.md')) continue;
      const abs = path.join(dir, file);
      const parsed = this.readOne(abs);
      if (!parsed) continue;
      const view: SubAgentView = {
        name: parsed.name,
        description: parsed.description,
        tools: parsed.tools,
        agents: parsed.agents,
        sourcePath: abs,
        ...(parsed.model !== undefined && { model: parsed.model }),
        ...(parsed.readonly !== undefined && { readonly: parsed.readonly }),
      };
      out.push(view);
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Reads one Devia-managed sub-agent file. Returns null when the
   *  file is unreadable or its frontmatter is missing required
   *  fields (`name` + body). */
  readOne(absPath: string): SubAgent | null {
    let raw: string;
    try { raw = fs.readFileSync(absPath, 'utf8'); }
    catch { return null; }
    const { frontmatter, body } = parseSubAgentFile(raw);
    const name = frontmatter.name ?? path.basename(absPath, '.md');
    if (!name) return null;
    return {
      name,
      description: frontmatter.description ?? '',
      tools: frontmatter.tools ?? [],
      agents: (frontmatter.agents ?? []) as SubAgentCliId[],
      body,
      ...(frontmatter.model !== undefined && { model: frontmatter.model }),
      ...(frontmatter.maxTurns !== undefined && { maxTurns: frontmatter.maxTurns }),
      ...(frontmatter.readonly !== undefined && { readonly: frontmatter.readonly }),
    };
  }

  /**
   * Scans every native dir / file under the project (`.claude/agents/`,
   * `.cursor/agents/`, `opencode.json`, …) and returns the union of
   * sub-agents found, deduplicated by name. The auto-import use case
   * consumes this list and writes the merged entries into
   * `.devia/sub-agents/`.
   */
  scanNative(projectPath: string): SubAgent[] {
    const byName = new Map<string, SubAgent>();

    for (const scan of importScanPaths(projectPath)) {
      if (scan.strategy === 'markdown-copy' || scan.strategy === 'slash-command') {
        if (!safeIsDir(scan.scanPath)) continue;
        for (const file of safeReaddir(scan.scanPath)) {
          if (!file.endsWith('.md')) continue;
          const abs = path.join(scan.scanPath, file);
          let raw: string;
          try { raw = fs.readFileSync(abs, 'utf8'); }
          catch { continue; }
          const { frontmatter, body } = parseSubAgentFile(raw);
          const name = frontmatter.name ?? path.basename(file, '.md');
          const existing = byName.get(name);
          const agents = unique([...(existing?.agents ?? []), scan.cli]);
          byName.set(name, mergeImport(existing, {
            name,
            description: frontmatter.description ?? existing?.description ?? '',
            tools: frontmatter.tools ?? existing?.tools ?? [],
            agents,
            body: existing?.body ?? body,
            ...(frontmatter.model !== undefined && { model: frontmatter.model }),
            ...(frontmatter.maxTurns !== undefined && { maxTurns: frontmatter.maxTurns }),
            ...(frontmatter.readonly !== undefined && { readonly: frontmatter.readonly }),
          }));
        }
      } else if (scan.strategy === 'json-merge') {
        // OpenCode's opencode.json has `agent.<name>` entries with
        // a `prompt` field. We read those into the same merged map.
        const parsed = safeReadJson(scan.scanPath);
        const block = (parsed?.['agent'] as Record<string, unknown> | undefined);
        if (block && typeof block === 'object') {
          for (const [name, value] of Object.entries(block)) {
            if (value === null || typeof value !== 'object') continue;
            const entry = value as Record<string, unknown>;
            const existing = byName.get(name);
            const tools = Array.isArray(entry['tools'])
              ? (entry['tools'] as unknown[]).filter((t): t is string => typeof t === 'string')
              : [];
            const body = typeof entry['prompt'] === 'string' ? entry['prompt'] : (existing?.body ?? '');
            const description = typeof entry['description'] === 'string' ? entry['description'] : (existing?.description ?? '');
            byName.set(name, mergeImport(existing, {
              name,
              description,
              tools: existing?.tools ?? tools,
              agents: unique([...(existing?.agents ?? []), scan.cli]),
              body,
              ...(typeof entry['model'] === 'string' && { model: entry['model'] }),
            }));
          }
        }
      }
    }
    return Array.from(byName.values());
  }
}

// ─── helpers ──────────────────────────────────────────────────────

function safeIsDir(p: string): boolean {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function safeReaddir(p: string): string[] {
  try { return fs.readdirSync(p); } catch { return []; }
}

function safeReadJson(p: string): Record<string, unknown> | null {
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function unique<T>(xs: T[]): T[] {
  return Array.from(new Set(xs));
}

function mergeImport(prev: SubAgent | undefined, next: SubAgent): SubAgent {
  if (!prev) return next;
  // When the same sub-agent appears under multiple native dirs, the
  // first occurrence wins for body/description (we don't have a
  // good way to pick otherwise) but `agents` is the union and
  // `tools` keeps the longer list.
  return {
    ...prev,
    agents: next.agents,
    tools: next.tools.length > prev.tools.length ? next.tools : prev.tools,
  };
}
