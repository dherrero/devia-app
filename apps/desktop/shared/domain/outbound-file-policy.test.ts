import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MIME,
  MAX_MEDIA_GROUP,
  MAX_PHOTO_BYTES,
  MAX_UPLOAD_BYTES,
  SECRET_PATH_PATTERNS,
  isInsideAnyRoot,
  isRootTooBroad,
  isSecretPath,
  mimeFromName,
  outboundKind,
} from './outbound-file-policy';

describe('isSecretPath', () => {
  it.each([
    '.env',
    '.env.production',
    'config/.env.local',
    '~/.ssh/config',
    'deploy.pem',
    'id_rsa.pub',
    '.git/config',
    'terraform.tfstate',
    'terraform.tfstate.backup',
    'prod.env',
    '/home/u/.aws/credentials',
    '/ws/p/.docker/config.json',
    '/ws/p/.claude/settings.local.json',
    '/Users/u/.devia-app/devia-app.config.json',
    'certs/server.KEY',
    'store.p12',
    'app.keystore',
    '.npmrc',
    '.netrc',
    'credentials.json',
    'secrets.yaml',
    'db.secret.txt',
    '.htpasswd',
    'C:\\Users\\u\\.ssh\\id_ed25519',
    'C:\\ws\\p\\.ENV',
    '/ws/p/.kube/config',
    '/ws/p/.gnupg/pubring.kbx',
    // H1: the user's rule is "never .env*", whatever follows the prefix.
    '.envrc',
    '.env-prod',
    '.env_local',
    '.env.example',
    'apps/api/.ENV.TEST',
    'local.env',
    '.dev.vars',
    '.git-credentials',
    '.credentials.json',
    '/Users/u/.config/gcloud/application_default_credentials.json',
    'application_default_credentials.json',
    'credentials',
    'credentials-api/README.md',
    'service-account.json',
    'service-account-prod.json',
    'token.json',
    'github.token',
    'prod.tfvars',
    'prod.tfvars.json',
    'id_dsa',
    'id_dsa.pub',
    'putty.ppk',
    'AuthKey_ABC123.p8',
    'kubeconfig',
    'kubeconfig.yaml',
    '.vault-token',
    'login.keychain',
    'login.keychain-db',
    '.zsh_history',
    '.bash_history',
    '.python_history',
    '.node_repl_history',
    '.my.cnf',
    '.s3cfg',
    '.terraformrc',
    '/Users/u/.config/gh/hosts.yml',
    '.config/gcloud/configurations/config_default',
  ])('refuses %s', (p) => {
    expect(isSecretPath(p)).toBe(true);
  });

  it.each([
    'env.ts',
    'environment.md',
    'keyboard.md',
    'README.md',
    'ssh-guide.md',
    'docs/ssh/setup.md',
    '.github/workflows/ci.yml',
    '.gitignore',
    'docker/config.json',
    '.claude/agents/dev.md',
    'out/report.pdf',
    'keys.ts',
    'monkey.png',
    'src/environment.prod.ts',
    'docs/env-setup.md',
    'tokenizer.json',
    'token-usage.md',
    'history.md',
    'history_test.ts',
    'hosts.yml',
    'gh/README.md',
    'config/gcloud.md',
    'variables.tf',
  ])('allows %s', (p) => {
    expect(isSecretPath(p)).toBe(false);
  });

  it('exports the denylist it enforces', () => {
    expect(SECRET_PATH_PATTERNS).toContain('.env*');
    expect(SECRET_PATH_PATTERNS).toContain('.ssh/');
    expect(SECRET_PATH_PATTERNS).toContain('terraform.tfstate*');
  });
});

describe('isInsideAnyRoot', () => {
  it('accepts a file under a root, and the root itself', () => {
    expect(isInsideAnyRoot('/ws/p/out/a.png', ['/ws'])).toBe(true);
    expect(isInsideAnyRoot('/ws', ['/ws'])).toBe(true);
    expect(isInsideAnyRoot('/ws/a', ['/ws/'])).toBe(true);
  });

  it('is not fooled by a shared prefix', () => {
    expect(isInsideAnyRoot('/ws-evil/a.png', ['/ws'])).toBe(false);
    expect(isInsideAnyRoot('/wsx', ['/ws'])).toBe(false);
  });

  it('checks every root', () => {
    expect(isInsideAnyRoot('/tmp/wt/a', ['/ws', '/tmp/wt'])).toBe(true);
    expect(isInsideAnyRoot('/etc/passwd', ['/ws', '/tmp/wt'])).toBe(false);
  });

  it('refuses everything with no roots, or an empty root', () => {
    expect(isInsideAnyRoot('/ws/a', [])).toBe(false);
    expect(isInsideAnyRoot('/ws/a', [''])).toBe(false);
    expect(isInsideAnyRoot('', ['/ws'])).toBe(false);
  });

  it('refuses an unresolved path', () => {
    expect(isInsideAnyRoot('/ws/../etc/passwd', ['/ws'])).toBe(false);
  });

  it('handles Windows separators', () => {
    expect(isInsideAnyRoot('C:\\ws\\p\\a.txt', ['C:\\ws'])).toBe(true);
    expect(isInsideAnyRoot('C:\\ws-evil\\a.txt', ['C:\\ws'])).toBe(false);
  });
});

describe('isRootTooBroad', () => {
  it('flags the home folder and every ancestor of it', () => {
    expect(isRootTooBroad('/Users/u', '/Users/u')).toBe(true);
    expect(isRootTooBroad('/Users/u/', '/Users/u')).toBe(true);
    expect(isRootTooBroad('/Users', '/Users/u')).toBe(true);
    expect(isRootTooBroad('/', '/Users/u')).toBe(true);
    expect(isRootTooBroad('C:\\Users\\u', 'C:\\Users\\u')).toBe(true);
  });

  it('accepts a folder below home, or elsewhere', () => {
    expect(isRootTooBroad('/Users/u/work', '/Users/u')).toBe(false);
    expect(isRootTooBroad('/Users/u2', '/Users/u')).toBe(false);
    expect(isRootTooBroad('/srv/ws', '/Users/u')).toBe(false);
  });

  it('never flags with a missing argument', () => {
    expect(isRootTooBroad('', '/Users/u')).toBe(false);
    expect(isRootTooBroad('/Users/u', '')).toBe(false);
  });
});

describe('Telegram limits', () => {
  it('are the Bot API cloud caps', () => {
    expect(MAX_UPLOAD_BYTES).toBe(50 * 1024 * 1024);
    expect(MAX_PHOTO_BYTES).toBe(10 * 1024 * 1024);
    expect(MAX_MEDIA_GROUP).toBe(10);
  });
});

describe('outboundKind', () => {
  it('maps media kinds', () => {
    expect(outboundKind('image/png', 'a.png')).toBe('photo');
    expect(outboundKind('image/jpeg', 'a.jpg')).toBe('photo');
    expect(outboundKind('video/mp4', 'a.mp4')).toBe('video');
    expect(outboundKind('audio/mpeg', 'a.mp3')).toBe('audio');
  });

  it('sends images Telegram cannot show as photos as documents', () => {
    expect(outboundKind('image/svg+xml', 'a.svg')).toBe('document');
    expect(outboundKind('image/gif', 'a.gif')).toBe('document');
  });

  it('sends everything else as a document', () => {
    expect(outboundKind('application/pdf', 'a.pdf')).toBe('document');
    expect(outboundKind('text/plain', 'a.txt')).toBe('document');
    expect(outboundKind(DEFAULT_MIME, 'a.bin')).toBe('document');
  });
});

describe('mimeFromName', () => {
  it('maps known extensions case-insensitively', () => {
    expect(mimeFromName('a.PNG')).toBe('image/png');
    expect(mimeFromName('/ws/p/report.pdf')).toBe('application/pdf');
    expect(mimeFromName('C:\\x\\clip.mp4')).toBe('video/mp4');
  });

  it('falls back to octet-stream', () => {
    expect(mimeFromName('Makefile')).toBe(DEFAULT_MIME);
    expect(mimeFromName('.bashrc')).toBe(DEFAULT_MIME);
    expect(mimeFromName('a.unknownext')).toBe(DEFAULT_MIME);
  });
});
