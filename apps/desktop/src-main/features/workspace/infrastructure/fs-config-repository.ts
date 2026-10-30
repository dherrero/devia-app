import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { ConfigRepository } from '../../../shared/ports';
import type { SecretSealer } from '../../../shared/secret-vault';
import {
  DEFAULT_CONFIG,
  DEFAULT_MEMORY_CONFIG,
  DEFAULT_REMOTE_CONTROL_CONFIG,
  type DeviaConfig,
  type MemoryConfig,
  type RemoteControlConfig,
  type TelegramIntegrationConfig,
} from '../../../../shared/domain/config';

const DIR_NAME = '.devia-app';
const CONFIG_FILENAME = 'devia-app.config.json';

export class FsConfigRepository implements ConfigRepository {
  private cache: DeviaConfig | null = null;

  /**
   * Optional secret sealer (E-DSK-14 #334). When provided, the Telegram bot
   * token is encrypted at rest: the on-disk JSON holds the sealed value while
   * the in-memory cache keeps it plaintext for the controller and the UI.
   */
  constructor(private readonly sealer?: SecretSealer) {}

  deviaDir(): string {
    return path.join(os.homedir(), DIR_NAME);
  }

  configPath(): string {
    return path.join(this.deviaDir(), CONFIG_FILENAME);
  }

  private ensureDir(): void {
    const dir = this.deviaDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  private loadFromDisk(): DeviaConfig {
    this.ensureDir();
    const file = this.configPath();
    if (!fs.existsSync(file)) return { ...DEFAULT_CONFIG };
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
      const partial = raw as Partial<DeviaConfig>;
      const merged: DeviaConfig = {
        ...DEFAULT_CONFIG,
        ...partial,
        memory: mergeMemory(partial.memory),
        remoteControl: mergeRemoteControl(partial.remoteControl),
      };
      // Decrypt the bot token sealed on disk so callers always see plaintext.
      if (this.sealer) {
        merged.remoteControl.telegram.botToken = this.sealer.open(merged.remoteControl.telegram.botToken);
      }
      return merged;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[config] invalid JSON, falling back to defaults:', message);
      return { ...DEFAULT_CONFIG };
    }
  }

  get(): DeviaConfig {
    if (!this.cache) this.cache = this.loadFromDisk();
    return this.cache;
  }

  set(partial: Partial<DeviaConfig>): DeviaConfig {
    this.ensureDir();
    const current = this.get();
    // Deep-merge the memory sub-object so a partial set({ memory: { blockExternalMemory: false } })
    // does not silently erase enabled/engramImported.
    const mergedMemory: MemoryConfig =
      partial.memory !== undefined
        ? { ...current.memory, ...partial.memory }
        : current.memory;
    // Same guard for the remote-control sub-object (and its nested telegram
    // block) so a partial set never erases sibling fields.
    const mergedRemoteControl: RemoteControlConfig =
      partial.remoteControl !== undefined
        ? {
            ...current.remoteControl,
            ...partial.remoteControl,
            telegram: { ...current.remoteControl.telegram, ...partial.remoteControl.telegram },
          }
        : current.remoteControl;
    this.cache = { ...current, ...partial, memory: mergedMemory, remoteControl: mergedRemoteControl };
    fs.writeFileSync(this.configPath(), JSON.stringify(this.toDisk(this.cache), null, 2));
    return this.cache;
  }

  reload(): DeviaConfig {
    this.cache = null;
    return this.get();
  }

  /**
   * Return a disk-bound copy of the config with the bot token sealed. The cache
   * keeps the plaintext token; only the persisted file carries the ciphertext.
   */
  private toDisk(config: DeviaConfig): DeviaConfig {
    if (!this.sealer) return config;
    return {
      ...config,
      remoteControl: {
        ...config.remoteControl,
        telegram: {
          ...config.remoteControl.telegram,
          botToken: this.sealer.seal(config.remoteControl.telegram.botToken),
        },
      },
    };
  }

  hasWorkspace(): boolean {
    const { workspaceRoot } = this.get();
    return !!workspaceRoot && fs.existsSync(workspaceRoot);
  }
}

/**
 * Deep-merge a persisted (possibly absent, partial, or malformed) memory block
 * onto the defaults: configs written before this feature existed still gain the
 * new keys, and a corrupt sub-object never strips a required flag. Only the
 * optional `engramImportedAt` is carried over when it is a real number, so the
 * result honours `exactOptionalPropertyTypes`.
 */
function mergeMemory(persisted: unknown): MemoryConfig {
  if (persisted === null || typeof persisted !== 'object') {
    return { ...DEFAULT_MEMORY_CONFIG };
  }
  const p = persisted as Partial<MemoryConfig> & { blockEngram?: unknown };
  return {
    enabled: typeof p.enabled === 'boolean' ? p.enabled : DEFAULT_MEMORY_CONFIG.enabled,
    // Migration: honour the new field, fall back to the legacy `blockEngram`
    // for configs written before the provider-neutral rename, then the default.
    blockExternalMemory:
      typeof p.blockExternalMemory === 'boolean'
        ? p.blockExternalMemory
        : typeof p.blockEngram === 'boolean'
          ? p.blockEngram
          : DEFAULT_MEMORY_CONFIG.blockExternalMemory,
    engramImported:
      typeof p.engramImported === 'boolean'
        ? p.engramImported
        : DEFAULT_MEMORY_CONFIG.engramImported,
    ...(typeof p.engramImportedAt === 'number' ? { engramImportedAt: p.engramImportedAt } : {}),
  };
}

/**
 * Deep-merge a persisted (possibly absent, partial, or malformed) remote-control
 * block onto the defaults (E-DSK-14): configs written before this feature
 * existed gain the new keys, and a corrupt sub-object never strips a required
 * flag or leaks a non-string token into the typed config.
 */
function mergeRemoteControl(persisted: unknown): RemoteControlConfig {
  const d = DEFAULT_REMOTE_CONTROL_CONFIG;
  if (persisted === null || typeof persisted !== 'object') {
    return {
      allowShell: d.allowShell,
      mirrorDesktop: d.mirrorDesktop,
      allowFileSend: d.allowFileSend,
      telegram: { ...d.telegram },
    };
  }
  const p = persisted as Partial<RemoteControlConfig>;
  const t: Partial<TelegramIntegrationConfig> =
    p.telegram !== null && typeof p.telegram === 'object' ? p.telegram : {};
  return {
    allowShell: typeof p.allowShell === 'boolean' ? p.allowShell : d.allowShell,
    mirrorDesktop: typeof p.mirrorDesktop === 'boolean' ? p.mirrorDesktop : d.mirrorDesktop,
    // S-32 T-370: configs written before the flag existed get the default (on).
    allowFileSend: typeof p.allowFileSend === 'boolean' ? p.allowFileSend : d.allowFileSend,
    telegram: {
      enabled: typeof t.enabled === 'boolean' ? t.enabled : d.telegram.enabled,
      botToken: typeof t.botToken === 'string' ? t.botToken : d.telegram.botToken,
      chatId: typeof t.chatId === 'string' ? t.chatId : d.telegram.chatId,
    },
  };
}
