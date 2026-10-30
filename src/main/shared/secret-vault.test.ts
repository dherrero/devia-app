import { describe, it, expect } from 'vitest';
import { createSecretVault, createEmbeddedKeyBackend, type EncryptionBackend } from './secret-vault';

/** A reversible fake backend (base64, no real crypto) for round-trip tests. */
function base64Backend(available = true): EncryptionBackend {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plain) => Buffer.from(plain, 'utf8'),
    decryptString: (data) => data.toString('utf8'),
  };
}

describe('createSecretVault', () => {
  it('seals with the enc: prefix and round-trips', () => {
    const vault = createSecretVault(base64Backend());
    const sealed = vault.seal('s3cr3t');
    expect(sealed.startsWith('enc:')).toBe(true);
    expect(sealed).not.toContain('s3cr3t');
    expect(vault.open(sealed)).toBe('s3cr3t');
  });

  it('returns empty for empty input', () => {
    const vault = createSecretVault(base64Backend());
    expect(vault.seal('')).toBe('');
    expect(vault.open('')).toBe('');
  });

  it('falls back to plain: when no backend is available', () => {
    const vault = createSecretVault();
    const sealed = vault.seal('tok');
    expect(sealed).toBe('plain:tok');
    expect(vault.open(sealed)).toBe('tok');
  });

  it('falls back to plain: when encryption is unavailable', () => {
    const vault = createSecretVault(base64Backend(false));
    expect(vault.seal('tok')).toBe('plain:tok');
  });

  it('returns legacy plaintext untouched', () => {
    const vault = createSecretVault(base64Backend());
    expect(vault.open('legacy-token')).toBe('legacy-token');
  });

  it('returns empty when an enc: value cannot be decrypted', () => {
    const failing: EncryptionBackend = {
      isEncryptionAvailable: () => true,
      encryptString: (p) => Buffer.from(p),
      decryptString: () => { throw new Error('no key'); },
    };
    const vault = createSecretVault(failing);
    expect(vault.open('enc:Zm9v')).toBe('');
  });

  it('cannot decrypt an enc: value without a backend', () => {
    expect(createSecretVault().open('enc:Zm9v')).toBe('');
  });

  it('uses the embedded key (enck:) when the OS backend is unavailable', () => {
    const vault = createSecretVault(base64Backend(false), createEmbeddedKeyBackend());
    const sealed = vault.seal('tok');
    expect(sealed.startsWith('enck:')).toBe(true);
    expect(sealed).not.toContain('tok');
    expect(vault.open(sealed)).toBe('tok');
  });

  it('prefers the OS backend (enc:) over the embedded key when available', () => {
    const vault = createSecretVault(base64Backend(true), createEmbeddedKeyBackend());
    expect(vault.seal('tok').startsWith('enc:')).toBe(true);
  });
});

describe('createEmbeddedKeyBackend', () => {
  it('round-trips through AES-256-GCM with a non-plaintext payload', () => {
    const backend = createEmbeddedKeyBackend();
    const enc = backend.encryptString('s3cr3t-token');
    expect(enc.toString('utf8')).not.toContain('s3cr3t-token');
    expect(backend.decryptString(enc)).toBe('s3cr3t-token');
  });

  it('produces a fresh IV each time (ciphertext differs)', () => {
    const backend = createEmbeddedKeyBackend();
    expect(backend.encryptString('x').equals(backend.encryptString('x'))).toBe(false);
  });

  it('fails to decrypt tampered data (GCM auth)', () => {
    const backend = createEmbeddedKeyBackend();
    const enc = backend.encryptString('tok');
    enc.writeUInt8(enc.readUInt8(enc.length - 1) ^ 0xff, enc.length - 1);
    expect(() => backend.decryptString(enc)).toThrow();
  });
});
