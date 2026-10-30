import { attachmentKind } from './attachment';

/**
 * What `devia_send_file` (S-32) may let out of the machine.
 *
 * The user's rule is fixed, not a setting: nothing outside the workspace, and
 * nothing that looks like a secret, ever leaves through the chat. The denylist
 * is a code constant on purpose — a config entry could be edited by the very
 * agent it is meant to restrain.
 *
 * Pure: every function takes strings the caller ALREADY resolved (realpath,
 * symlinks followed). Imported by the main process, the renderer and the
 * out-of-process MCP server, so no Node and no Electron here.
 */

/**
 * Glob-ish patterns matched case-insensitively against path SEGMENTS.
 *
 * - `name/`       a directory anywhere in the path;
 * - `a/b`         consecutive segments anywhere in the path;
 * - anything else any single segment (so `credentials/` as a directory is
 *                 refused too, which is the conservative reading).
 *
 * `*` never crosses a separator. Exported for the tests and for the prompt
 * text, which lists them so the agent does not even try.
 */
export const SECRET_PATH_PATTERNS: readonly string[] = [
  // The user's rule: never anything `.env*` (`.env`, `.env.local`, `.envrc`,
  // `.env-prod`, `.env_local`, `.env.example`…) nor `*.env`.
  '.env*',
  '*.env',
  '.dev.vars',
  '.ssh/',
  '.gnupg/',
  '.aws/',
  '.azure/',
  '.kube/',
  '.config/gcloud/',
  'gh/hosts.yml',
  '.docker/config.json',
  '.git/',
  'id_rsa*',
  'id_dsa*',
  'id_ed25519*',
  'id_ecdsa*',
  '*.pem',
  '*.key',
  '*.p12',
  '*.p8',
  '*.pfx',
  '*.ppk',
  '*.keystore',
  '*.jks',
  '*.keychain',
  '*.keychain-db',
  'kubeconfig*',
  '.npmrc',
  '.pypirc',
  '.netrc',
  '.pgpass',
  '.my.cnf',
  '.s3cfg',
  '.terraformrc',
  '.vault-token',
  // Anywhere in the name: `.git-credentials`, `.credentials.json`,
  // `application_default_credentials.json`, a `credentials/` folder… Also a
  // `credentials-api/` project folder INSIDE the workspace — cautious on purpose.
  '*credentials*',
  'service-account*.json',
  'token.json',
  '*.token',
  'secrets.*',
  '*.secret*',
  '.htpasswd',
  // Shell / REPL histories carry pasted tokens: `.zsh_history`, `.bash_history`…
  '*_history',
  '.claude/settings*.json',
  'devia-app.config.json',
  'terraform.tfstate*',
  '*.tfvars',
  '*.tfvars.json',
];

const COMPILED: readonly RegExp[][] = SECRET_PATH_PATTERNS.map((pattern) =>
  pattern
    .replace(/\/$/, '')
    .split('/')
    .map((segment) => globToRegExp(segment)),
);

export function isSecretPath(p: string): boolean {
  const segments = splitPath(p).map((s) => s.toLowerCase());
  return COMPILED.some((sequence) => containsSequence(segments, sequence));
}

/**
 * Telegram Bot API upload limits (cloud API server), the single source for
 * the guard, the gate and the Telegram client. Photos above `MAX_PHOTO_BYTES`
 * are sent as documents instead.
 */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
export const MAX_CAPTION_CHARS = 1024;
export const MAX_MEDIA_GROUP = 10;

/**
 * A send root that is the user's home folder or one of its ancestors (`/`,
 * `/Users`) would put every dotfile, keychain and download in reach of a
 * single misjudged pattern: file sending is disabled for it instead. Both
 * arguments are absolute (and, ideally, resolved) paths.
 */
export function isRootTooBroad(root: string, homeDir: string): boolean {
  if (!root || !homeDir) return false;
  return isInsideAnyRoot(homeDir, [root]);
}

export type OutboundKind = 'photo' | 'video' | 'audio' | 'document';

/**
 * Formats Telegram renders inline as a photo. Any other image (svg, gif, heic,
 * tiff…) is sent as a document: `sendPhoto` rejects or flattens them.
 */
const PHOTO_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export function outboundKind(mime: string, name = ''): OutboundKind {
  switch (attachmentKind(mime, name)) {
    case 'image':
      return PHOTO_MIMES.has(mime.toLowerCase()) ? 'photo' : 'document';
    case 'video':
      return 'video';
    case 'audio':
      return 'audio';
    default:
      return 'document';
  }
}

const MIME_BY_EXT: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  heic: 'image/heic',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  pdf: 'application/pdf',
  zip: 'application/zip',
  gz: 'application/gzip',
  tgz: 'application/gzip',
  tar: 'application/x-tar',
  '7z': 'application/x-7z-compressed',
  json: 'application/json',
  xml: 'application/xml',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  txt: 'text/plain',
  log: 'text/plain',
  md: 'text/markdown',
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  mjs: 'text/javascript',
  ts: 'text/plain',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

export const DEFAULT_MIME = 'application/octet-stream';

export function mimeFromName(name: string): string {
  const base = splitPath(name).pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return DEFAULT_MIME;
  return MIME_BY_EXT[base.slice(dot + 1).toLowerCase()] ?? DEFAULT_MIME;
}

/**
 * Whether `realPath` sits inside (or IS) one of `roots`.
 *
 * Prefix match WITH a trailing separator, so `/ws-evil` is not inside `/ws`.
 * A path with a `..` segment is refused outright: the caller promised a
 * resolved path, and one that is not cannot be judged by its prefix.
 * Case-sensitive — the caller passes realpaths, which carry the on-disk case.
 */
export function isInsideAnyRoot(realPath: string, roots: readonly string[]): boolean {
  if (!realPath || splitPath(realPath).includes('..')) return false;
  const target = trimTrailingSeparators(realPath);
  return roots.some((raw) => {
    if (!raw) return false;
    const root = trimTrailingSeparators(raw);
    if (target === root) return true;
    if (!target.startsWith(root)) return false;
    // A root that is itself just separators (`/`) already ends in one.
    if (/[\\/]$/.test(root)) return true;
    const next = target.charAt(root.length);
    return next === '/' || next === '\\';
  });
}

function splitPath(p: string): string[] {
  return p.split(/[\\/]+/).filter((s) => s.length > 0);
}

function trimTrailingSeparators(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '');
  return trimmed === '' ? p.charAt(0) : trimmed;
}

function containsSequence(segments: readonly string[], sequence: readonly RegExp[]): boolean {
  for (let i = 0; i + sequence.length <= segments.length; i++) {
    if (sequence.every((re, j) => re.test(segments[i + j] ?? ''))) return true;
  }
  return false;
}

function globToRegExp(glob: string): RegExp {
  const source = glob
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^\\\\/]*');
  return new RegExp(`^${source}$`, 'i');
}
