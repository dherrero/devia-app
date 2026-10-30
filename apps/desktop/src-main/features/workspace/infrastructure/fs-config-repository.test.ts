import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FsConfigRepository } from './fs-config-repository';
import { createSecretVault, type EncryptionBackend } from '../../../shared/secret-vault';

function base64Backend(): EncryptionBackend {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plain) => Buffer.from(plain, 'utf8'),
    decryptString: (data) => data.toString('utf8'),
  };
}

describe('FsConfigRepository - token sealing (E-DSK-14 #334)', () => {
  it('seals the bot token on disk and decrypts it on load', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devia-cfg-'));
    const prevHome = process.env['HOME'];
    process.env['HOME'] = tmp;
    try {
      // Skip safely if this platform's os.homedir() ignores $HOME (so the test
      // never writes to the real ~/.devia-app).
      if (!os.homedir().startsWith(tmp)) return;

      const sealer = createSecretVault(base64Backend());
      const repo = new FsConfigRepository(sealer);
      repo.set({
        remoteControl: {
          allowShell: false,
          mirrorDesktop: false,
          allowFileSend: true,
          telegram: { enabled: true, botToken: 'SUPER_SECRET', chatId: '42' },
        },
      });

      const raw = fs.readFileSync(repo.configPath(), 'utf8');
      const onDisk = JSON.parse(raw) as { remoteControl: { telegram: { botToken: string } } };
      expect(onDisk.remoteControl.telegram.botToken.startsWith('enc:')).toBe(true);
      expect(raw).not.toContain('SUPER_SECRET');

      const reloaded = new FsConfigRepository(sealer).get();
      expect(reloaded.remoteControl.telegram.botToken).toBe('SUPER_SECRET');
      expect(reloaded.remoteControl.telegram.chatId).toBe('42');
    } finally {
      if (prevHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = prevHome;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('FsConfigRepository - remoteControl.allowFileSend (S-32 T-370)', () => {
  /** Runs `body` with $HOME pointed at a throwaway dir holding `persisted` (if any). */
  function withConfigOnDisk(persisted: unknown, body: (repo: FsConfigRepository) => void): void {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devia-cfg-'));
    const prevHome = process.env['HOME'];
    process.env['HOME'] = tmp;
    try {
      if (!os.homedir().startsWith(tmp)) return;
      const repo = new FsConfigRepository();
      if (persisted !== undefined) {
        fs.mkdirSync(repo.deviaDir(), { recursive: true });
        fs.writeFileSync(repo.configPath(), JSON.stringify(persisted));
      }
      body(repo);
    } finally {
      if (prevHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = prevHome;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  it('defaults to true when there is no config file', () => {
    withConfigOnDisk(undefined, (repo) => {
      expect(repo.get().remoteControl.allowFileSend).toBe(true);
    });
  });

  it('migrates an old config without the field to true, keeping its other flags', () => {
    withConfigOnDisk(
      {
        remoteControl: {
          allowShell: true,
          mirrorDesktop: true,
          telegram: { enabled: true, botToken: 't', chatId: '1' },
        },
      },
      (repo) => {
        const rc = repo.get().remoteControl;
        expect(rc.allowFileSend).toBe(true);
        expect(rc.allowShell).toBe(true);
        expect(rc.mirrorDesktop).toBe(true);
      },
    );
  });

  it('respects an explicit false', () => {
    withConfigOnDisk(
      {
        remoteControl: {
          allowShell: false,
          mirrorDesktop: false,
          allowFileSend: false,
          telegram: { enabled: true, botToken: 't', chatId: '1' },
        },
      },
      (repo) => {
        expect(repo.get().remoteControl.allowFileSend).toBe(false);
      },
    );
  });

  it('falls back to true when the persisted value is not a boolean', () => {
    withConfigOnDisk({ remoteControl: { allowFileSend: 'yes' } }, (repo) => {
      expect(repo.get().remoteControl.allowFileSend).toBe(true);
    });
  });

  it('persists a false set() and reloads it as false', () => {
    withConfigOnDisk(undefined, (repo) => {
      repo.set({ remoteControl: { ...repo.get().remoteControl, allowFileSend: false } });
      expect(new FsConfigRepository().get().remoteControl.allowFileSend).toBe(false);
    });
  });
});
