import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Marks a project as TRUSTED in Codex's global config so its project-scoped
 * layer actually loads.
 *
 * Per the Codex config reference (developers.openai.com/codex/config-reference),
 * an untrusted project skips EVERY project-scoped configuration layer —
 * including `<project>/.codex/config.toml`, which is exactly where Devia
 * injects its devia-kanban / devia-memory MCP servers. Without this trust
 * entry a freshly created project runs Codex with no Devia tools and the
 * default policy rejecting commands ("rejected: blocked by policy").
 *
 * This is the Codex counterpart of {@link ensureClaudeDefaults}: Devia manages
 * the project, so creating/running it IS the consent step (same model as the
 * Claude permissions baseline).
 *
 * Trust lives in `$CODEX_HOME/config.toml` (default `~/.codex/config.toml`) as
 *   [projects.'<absolute path>']
 *   trust_level = "trusted"
 *
 * The write is surgical and conservative: existing content is preserved
 * byte-for-byte, the new entry is appended inside Devia marker comments, the
 * write is atomic (tmp + rename), it is idempotent (any existing `[projects.*]`
 * entry for the same path — Devia's or the user's — short-circuits), and it
 * never throws (a warn is logged and the caller continues; the run then simply
 * behaves like today's untrusted flow).
 */
export function ensureCodexTrust(
  projectAbsPath: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  try {
    const codexHome = env['CODEX_HOME'] || path.join(os.homedir(), '.codex');
    const configPath = path.join(codexHome, 'config.toml');
    const normalized = normalizeForCodex(projectAbsPath);

    const existing = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
    if (hasProjectEntry(existing, normalized)) return;

    const block = [
      `# devia-trust-start ${normalized}`,
      `[projects.'${normalized}']`,
      'trust_level = "trusted"',
      `# devia-trust-end ${normalized}`,
      '',
    ].join('\n');
    const prefix = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
    const separator = existing.length === 0 ? '' : '\n';

    fs.mkdirSync(codexHome, { recursive: true });
    const tmp = `${configPath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, existing + prefix + separator + block, 'utf8');
    fs.renameSync(tmp, configPath);
  } catch (err: unknown) {
    console.warn(
      `[devia:codex] could not mark project as trusted in codex config (${projectAbsPath}):`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Codex normalizes project keys before persisting trust: on Windows it writes
 * lowercase drive + backslashes (observed in real `~/.codex/config.toml`
 * entries). Matching that spelling keeps one entry per project instead of a
 * Devia duplicate that Codex might not match.
 */
function normalizeForCodex(projectAbsPath: string): string {
  const resolved = path.resolve(projectAbsPath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * True when the config already carries a `[projects.'<path>']` (or double
 * quoted / unquoted) table header for this path, whoever wrote it. Windows
 * paths compare case-insensitively.
 */
function hasProjectEntry(configText: string, normalizedPath: string): boolean {
  const wanted = process.platform === 'win32' ? normalizedPath.toLowerCase() : normalizedPath;
  const headerRe = /^\s*\[projects\.(?:'([^']+)'|"([^"]+)"|([^\]]+))\]\s*$/gm;
  for (const match of configText.matchAll(headerRe)) {
    // Double-quoted TOML keys escape backslashes; literal (single-quoted) and
    // bare keys are taken verbatim.
    const raw = (match[1] ?? match[2]?.replace(/\\\\/g, '\\') ?? match[3] ?? '').trim();
    if (raw === '') continue;
    const entry = process.platform === 'win32' ? raw.toLowerCase() : raw;
    if (entry === wanted) return true;
  }
  return false;
}
