import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Encryption-at-rest for small secrets (E-DSK-14 #334).
 *
 * Wraps Electron's `safeStorage` (OS keychain / DPAPI / libsecret) behind a
 * tiny interface so the config repository can seal a token before it touches
 * disk and open it back on load — without importing Electron itself (kept
 * injectable so the repository and its tests stay Electron-free).
 *
 * When no OS keychain is available (e.g. WSL, headless Linux) we fall back to
 * an app-embedded AES-256-GCM key instead of storing the token in plaintext.
 *
 * Sealed values are tagged so any value round-trips losslessly:
 *   - `enc:<base64>`   → encrypted with the OS backend (safeStorage)
 *   - `enck:<base64>`  → encrypted with the app-embedded key (no keychain)
 *   - `plain:<text>`   → stored as-is (no backend at all)
 *   - anything else    → legacy plaintext, returned untouched
 */
export interface EncryptionBackend {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(data: Buffer): string;
}

export interface SecretSealer {
  /** Encode a plaintext secret for storage. Empty input → empty output. */
  seal(plain: string): string;
  /** Decode a stored secret back to plaintext. Unknown/corrupt → ''. */
  open(sealed: string): string;
}

const ENC_PREFIX = 'enc:';
const ENCK_PREFIX = 'enck:';
const PLAIN_PREFIX = 'plain:';

/**
 * Builds a sealer. `osBackend` is preferred (machine-bound, e.g. safeStorage);
 * `keyBackend` is the app-embedded fallback used when the OS one is
 * unavailable, so a secret is never written in plaintext when a fallback
 * exists. Decryption routes by tag, so values stay readable either way.
 */
export function createSecretVault(
  osBackend?: EncryptionBackend,
  keyBackend?: EncryptionBackend,
): SecretSealer {
  return {
    seal(plain: string): string {
      if (!plain) return '';
      if (osBackend?.isEncryptionAvailable()) {
        try {
          return ENC_PREFIX + osBackend.encryptString(plain).toString('base64');
        } catch {
          /* fall through */
        }
      }
      if (keyBackend?.isEncryptionAvailable()) {
        try {
          return ENCK_PREFIX + keyBackend.encryptString(plain).toString('base64');
        } catch {
          /* fall through to plaintext tagging */
        }
      }
      return PLAIN_PREFIX + plain;
    },
    open(sealed: string): string {
      if (!sealed) return '';
      if (sealed.startsWith(ENC_PREFIX)) {
        if (!osBackend) return '';
        try {
          return osBackend.decryptString(Buffer.from(sealed.slice(ENC_PREFIX.length), 'base64'));
        } catch {
          return '';
        }
      }
      if (sealed.startsWith(ENCK_PREFIX)) {
        if (!keyBackend) return '';
        try {
          return keyBackend.decryptString(Buffer.from(sealed.slice(ENCK_PREFIX.length), 'base64'));
        } catch {
          return '';
        }
      }
      if (sealed.startsWith(PLAIN_PREFIX)) return sealed.slice(PLAIN_PREFIX.length);
      return sealed; // legacy plaintext written before sealing existed
    },
  };
}

/**
 * App-embedded AES-256-GCM backend. The key is derived from a constant that
 * ships in the build, so this is OBFUSCATION-GRADE only: it keeps the token
 * out of plaintext on disk and defeats casual inspection, but anyone with the
 * app's code can derive the key. Used solely as a fallback when the OS keychain
 * (safeStorage) is unavailable — a real keychain is always preferred. Buffer
 * layout: iv(12) ‖ authTag(16) ‖ ciphertext.
 */
const EMBEDDED_KEY_MATERIAL = 'devia::remote-control::token-vault::v1';

export function createEmbeddedKeyBackend(secret: string = EMBEDDED_KEY_MATERIAL): EncryptionBackend {
  const key = createHash('sha256').update(secret).digest(); // 32 bytes
  return {
    isEncryptionAvailable: () => true,
    encryptString(plain: string): Buffer {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
    },
    decryptString(data: Buffer): string {
      const iv = data.subarray(0, 12);
      const authTag = data.subarray(12, 28);
      const ciphertext = data.subarray(28);
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(authTag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    },
  };
}
