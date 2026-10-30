import * as path from 'node:path';
import type { SubAgentCliId } from '../../../../shared/domain/sub-agents';

/**
 * Per-CLI target table for the sub-agent synchroniser (#275).
 *
 * Each CLI has a strategy (Markdown copy / JSON merge / slash
 * command) and an absolute file or directory path inside the
 * project. The writer dispatches on `strategy`.
 *
 * Codex / DeepSeek are intentionally absent — they don't have a
 * sub-agent surface. The install use case turns those into no-ops
 * with a status message back to the renderer.
 */

export type SubAgentStrategy = 'markdown-copy' | 'json-merge' | 'slash-command';

export interface SubAgentTarget {
  /** Strategy the synchroniser uses to materialise this entry. */
  readonly strategy: SubAgentStrategy;
  /** For markdown-copy / slash-command: absolute file path. */
  readonly file?: string;
  /** For markdown-copy / slash-command: parent dir (we mkdirp). */
  readonly dir?: string;
  /** For json-merge: absolute path of the JSON file we merge into. */
  readonly jsonFile?: string;
  /** For json-merge: top-level key under which each entry lives
   *  (`agent` for OpenCode, `mcpServers`-shaped for Copilot, …). */
  readonly jsonParentKey?: string;
  /** Settings file Devia must also touch (Gemini requires the
   *  `experimental.enableAgents: true` flag). Optional. */
  readonly companionFile?: string;
}

/**
 * Resolve the target for `(cli, name, projectPath)`. Returns null
 * for unsupported CLIs (codex/deepseek). The renderer never asks
 * for unsupported CLIs — defence in depth in case a stale UI
 * sends one.
 */
export function resolveSubAgentTarget(
  cli: SubAgentCliId,
  name: string,
  projectPath: string,
): SubAgentTarget | null {
  switch (cli) {
    case 'claude':
      return {
        strategy: 'markdown-copy',
        dir: path.join(projectPath, '.claude', 'agents'),
        file: path.join(projectPath, '.claude', 'agents', `${name}.md`),
      };
    case 'cursor-agent':
      return {
        strategy: 'markdown-copy',
        dir: path.join(projectPath, '.cursor', 'agents'),
        file: path.join(projectPath, '.cursor', 'agents', `${name}.md`),
      };
    case 'gemini':
      return {
        strategy: 'markdown-copy',
        dir: path.join(projectPath, '.gemini', 'agents'),
        file: path.join(projectPath, '.gemini', 'agents', `${name}.md`),
        companionFile: path.join(projectPath, '.gemini', 'settings.json'),
      };
    case 'opencode':
      return {
        strategy: 'json-merge',
        jsonFile: path.join(projectPath, 'opencode.json'),
        jsonParentKey: 'agent',
      };
    case 'qwen':
      return {
        strategy: 'slash-command',
        dir: path.join(projectPath, '.qwen', 'commands'),
        file: path.join(projectPath, '.qwen', 'commands', `${name}.md`),
      };
    case 'copilot':
      return {
        strategy: 'json-merge',
        jsonFile: path.join(projectPath, '.vscode', 'copilot-agents.json'),
        jsonParentKey: 'agents',
      };
    case 'codex':
      // Codex is solo-agent — no sub-agent surface. The install
      // use case treats this as a `skipped` entry.
      return null;
  }
}

/** Read-side: every dir/file the auto-import scans on project open. */
export function importScanPaths(projectPath: string): Array<{
  cli: SubAgentCliId;
  strategy: SubAgentStrategy;
  scanPath: string;
}> {
  return [
    {
      cli: 'claude',
      strategy: 'markdown-copy',
      scanPath: path.join(projectPath, '.claude', 'agents'),
    },
    {
      cli: 'cursor-agent',
      strategy: 'markdown-copy',
      scanPath: path.join(projectPath, '.cursor', 'agents'),
    },
    {
      cli: 'gemini',
      strategy: 'markdown-copy',
      scanPath: path.join(projectPath, '.gemini', 'agents'),
    },
    {
      cli: 'qwen',
      strategy: 'slash-command',
      scanPath: path.join(projectPath, '.qwen', 'commands'),
    },
    {
      cli: 'opencode',
      strategy: 'json-merge',
      scanPath: path.join(projectPath, 'opencode.json'),
    },
  ];
}
