import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Writes a default `.claude/settings.local.json` inside a project so that
 * Claude can run there without first prompting for permissions, and adds
 * the file to the project's `.gitignore` so the local overrides stay local.
 *
 * Idempotent and conservative: skips entirely when the settings file
 * already exists (preserves user overrides and config that ships with a
 * base or cloned repo), and only appends to `.gitignore` when no existing
 * line already covers `.claude/settings.local.json`.
 */
export function ensureClaudeDefaults(projectAbsPath: string): void {
  const settingsPath = path.join(projectAbsPath, CLAUDE_SETTINGS_REL);
  if (fs.existsSync(settingsPath)) return;

  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(DEFAULT_CLAUDE_SETTINGS, null, 2) + '\n');

  appendGitignoreEntry(projectAbsPath, CLAUDE_SETTINGS_REL);
}

const CLAUDE_SETTINGS_REL = '.claude/settings.local.json';

const DEFAULT_CLAUDE_SETTINGS = {
  permissions: {
    allow: [
      'Bash(git status)',
      'Bash(git diff*)',
      'Bash(git log*)',
      'Bash(git add*)',
      'Bash(git commit*)',
      'Bash(git checkout*)',
      'Bash(git branch*)',
      'Bash(git push -u origin feat/*)',
      'Bash(git push origin feat/*)',
      'Bash(git push -u origin fix/*)',
      'Bash(git push origin fix/*)',
      'Bash(ls*)',
      'Bash(cat*)',
      'Bash(mkdir*)',
      'Bash(npm install*)',
      'Bash(npm run*)',
      'Bash(npx *)',
      'Write(*)',
      'Edit(*)',
      'Read(*)',
    ],
    deny: [
      'Bash(rm -rf*)',
      'Bash(git push --force*)',
      'Bash(git reset --hard*)',
      'Bash(git push origin main*)',
      'Bash(git push origin master*)',
    ],
  },
};

// Any of these lines already cover `.claude/settings.local.json`, so a
// dedicated entry on top would be redundant.
const GITIGNORE_COVERING_PATTERNS = [
  '.claude/settings.local.json',
  '.claude/',
  '.claude',
  '.claude/*',
];

function appendGitignoreEntry(projectAbsPath: string, entry: string): void {
  const gitignorePath = path.join(projectAbsPath, '.gitignore');
  const existing = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf8') : '';
  const lines = existing.split(/\r?\n/).map((l) => l.trim());
  if (lines.some((l) => GITIGNORE_COVERING_PATTERNS.includes(l))) return;

  const prefix = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
  fs.writeFileSync(gitignorePath, existing + prefix + entry + '\n');
}

// ── MCP permission (single source of truth) ─────────────────────────────────
//
// Devia's headless `claude -p` runtime has NO interactive permission approver,
// so an MCP server that is loaded but not allow-listed has its tools denied and
// is unusable. Rather than a per-run `--allowedTools` flag, the grant lives in
// the project's `.claude/settings.local.json` — Claude re-reads it at the start
// of every `-p` invocation, so the very next turn already sees it. Devia adding
// a server (its kanban, or one the user installs in the MCP manager) IS the
// consent step.

type JsonObject = Record<string, unknown>;

/**
 * Grant a project's local Claude settings the right to LOAD and AUTO-RUN the
 * given MCP servers. Upserts into `.claude/settings.local.json`:
 *   - `permissions.allow` gains `"mcp__<id>"` per server (whole-server approve).
 *   - when `trustProjectMcpjson` is set, `enabledMcpjsonServers` gains each id so
 *     servers declared in the project `.mcp.json` are trusted in `-p` mode.
 *     Servers delivered to Claude via `--mcp-config` are auto-trusted and do
 *     NOT need this — only project-scope `.mcp.json` servers do.
 *
 * Idempotent (writes only on change), preserves every other key, and never
 * touches permissions unrelated to MCP. A malformed existing file is left
 * untouched (Claude ignores invalid settings anyway). Ensures the file is
 * gitignored when it has to create it.
 */
export function grantClaudeMcpAccess(
  projectAbsPath: string,
  serverIds: readonly string[],
  opts: { trustProjectMcpjson?: boolean } = {},
): void {
  if (serverIds.length === 0) return;
  const settingsPath = path.join(projectAbsPath, CLAUDE_SETTINGS_REL);
  const read = readSettingsObject(settingsPath);
  if (read.kind === 'malformed') return;
  const creating = read.kind === 'absent';
  const settings: JsonObject = read.kind === 'object' ? read.data : {};

  let changed = creating;

  const permissions = isRecord(settings['permissions']) ? settings['permissions'] : {};
  const rawAllow = permissions['allow'];
  const allow: unknown[] = Array.isArray(rawAllow) ? [...rawAllow] : [];
  for (const id of serverIds) {
    const entry = `mcp__${id}`;
    if (!allow.includes(entry) && !allow.includes(`${entry}__*`)) {
      allow.push(entry);
      changed = true;
    }
  }
  permissions['allow'] = allow;
  settings['permissions'] = permissions;

  if (opts.trustProjectMcpjson && settings['enableAllProjectMcpServers'] !== true) {
    const rawTrusted = settings['enabledMcpjsonServers'];
    const trusted: unknown[] = Array.isArray(rawTrusted) ? [...rawTrusted] : [];
    for (const id of serverIds) {
      if (!trusted.includes(id) && !trusted.includes('*')) {
        trusted.push(id);
        changed = true;
      }
    }
    settings['enabledMcpjsonServers'] = trusted;
  }

  if (!changed) return;
  writeSettingsObject(settingsPath, settings);
  if (creating) appendGitignoreEntry(projectAbsPath, CLAUDE_SETTINGS_REL);
}

/**
 * Removes the `AskUserQuestion` PreToolUse hook Devia used to install.
 *
 * Claude Code 2.1.220 dropped `AskUserQuestion` from headless runs, so the hook
 * can never fire again (S-24 replaced it with the `devia-ask` MCP server). It
 * is NOT enough to stop installing it: Devia wrote that entry into the
 * `.claude/settings.local.json` of every project it ever ran in, and left there
 * it points at a script path that may no longer exist. So this runs once per
 * run and cleans up whatever it finds — self-healing, like the install was.
 *
 * Surgical on purpose: only hooks Devia itself wrote are removed (matched by
 * {@link isDeviaAskUserQuestionCommandHook}). A hook the user added under the
 * same matcher keeps the group alive; an absent or malformed file is left
 * untouched, and the file is never created just to clean it.
 */
export function removeDeviaAskUserQuestionHook(projectAbsPath: string): void {
  const settingsPath = path.join(projectAbsPath, CLAUDE_SETTINGS_REL);
  const read = readSettingsObject(settingsPath);
  if (read.kind !== 'object') return;
  const settings = read.data;

  const hooks = settings['hooks'];
  if (!isRecord(hooks)) return;
  const preToolUse = hooks['PreToolUse'];
  if (!Array.isArray(preToolUse)) return;

  let changed = false;
  const nextPreToolUse: unknown[] = [];
  for (const entry of preToolUse) {
    if (!isRecord(entry) || entry['matcher'] !== 'AskUserQuestion') {
      nextPreToolUse.push(entry);
      continue;
    }
    const rawHooks = Array.isArray(entry['hooks']) ? entry['hooks'] : [];
    const kept = rawHooks.filter((hook) => !isDeviaAskUserQuestionCommandHook(hook));
    if (kept.length !== rawHooks.length) changed = true;
    // A group left with no hooks is noise — drop it entirely.
    if (kept.length > 0) nextPreToolUse.push({ ...entry, hooks: kept });
  }
  if (!changed) return;

  if (nextPreToolUse.length > 0) {
    hooks['PreToolUse'] = nextPreToolUse;
  } else {
    delete hooks['PreToolUse'];
  }
  if (Object.keys(hooks).length === 0) {
    delete settings['hooks'];
  }
  writeSettingsObject(settingsPath, settings);
}

function isDeviaAskUserQuestionCommandHook(hook: unknown): boolean {
  if (!isRecord(hook)) return false;
  const command = hook['command'];
  if (typeof command === 'string' && command.includes('ask-user-question-hook.js')) return true;
  const args = hook['args'];
  if (!Array.isArray(args)) return false;
  return args.some((arg) => typeof arg === 'string' && path.basename(arg) === 'ask-user-question-hook.js');
}

/**
 * Reverse of {@link grantClaudeMcpAccess}: strip the given servers' `mcp__<id>`
 * allow entries and `enabledMcpjsonServers` ids. No-op when the file is missing
 * or malformed.
 */
export function revokeClaudeMcpAccess(
  projectAbsPath: string,
  serverIds: readonly string[],
): void {
  if (serverIds.length === 0) return;
  const settingsPath = path.join(projectAbsPath, CLAUDE_SETTINGS_REL);
  const read = readSettingsObject(settingsPath);
  if (read.kind !== 'object') return;
  const settings = read.data;

  let changed = false;
  const allowToRemove = new Set(serverIds.flatMap((id) => [`mcp__${id}`, `mcp__${id}__*`]));
  const idsToRemove = new Set<string>(serverIds);

  const permissions = isRecord(settings['permissions']) ? settings['permissions'] : null;
  const rawAllow = permissions?.['allow'];
  if (permissions && Array.isArray(rawAllow)) {
    const next = rawAllow.filter((e) => typeof e !== 'string' || !allowToRemove.has(e));
    if (next.length !== rawAllow.length) { permissions['allow'] = next; changed = true; }
  }
  const rawTrusted = settings['enabledMcpjsonServers'];
  if (Array.isArray(rawTrusted)) {
    const next = rawTrusted.filter((e) => typeof e !== 'string' || !idsToRemove.has(e));
    if (next.length !== rawTrusted.length) { settings['enabledMcpjsonServers'] = next; changed = true; }
  }

  if (changed) writeSettingsObject(settingsPath, settings);
}

// ── settings.local.json read/write helpers ──────────────────────────────────

type SettingsRead =
  | { kind: 'object'; data: JsonObject }
  | { kind: 'absent' }
  | { kind: 'malformed' };

function isRecord(v: unknown): v is JsonObject {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function readSettingsObject(file: string): SettingsRead {
  let raw: string;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return { kind: 'absent' }; }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed)) return { kind: 'object', data: parsed };
  } catch { /* fall through */ }
  console.warn(`[claude-defaults] ${file} is not a valid JSON object — leaving MCP permission untouched.`);
  return { kind: 'malformed' };
}

function writeSettingsObject(file: string, settings: JsonObject): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}
