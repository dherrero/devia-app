import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BasesStore } from '../domain/ports';
import type { ConfigRepository } from '../../../shared/ports';
import type { BasesMap } from '../../../../shared/domain/base';

const FILENAME = 'bases.json';
const SEED_TEMPLATE: BasesMap = {
  'fullstack-starter': {
    repository: 'git@github.com:dherrero/fullstack-starter.git',
    autoSetup: 'Set up GitHub repository and CI/CD for this project.',
  },
};

/**
 * Persists project bases as JSON in `<deviaDir>/bases.json`. The file is
 * created lazily with a single sample entry the first time the user opens the
 * editor — the alternative (an empty file) gives no hint about the expected
 * shape and makes the "no hay bases" state harder to recover from.
 */
export class FsBasesStore implements BasesStore {
  constructor(private readonly config: ConfigRepository) {}

  filePath(): string {
    return path.join(this.config.deviaDir(), FILENAME);
  }

  private ensureFile(): void {
    const dir = this.config.deviaDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const file = this.filePath();
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, JSON.stringify(SEED_TEMPLATE, null, 2));
    }
  }

  read(): BasesMap {
    const file = this.filePath();
    if (!fs.existsSync(file)) return {};
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
      return raw as BasesMap;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[bases] invalid JSON, falling back to empty map:', message);
      return {};
    }
  }

  readText(): string {
    this.ensureFile();
    return fs.readFileSync(this.filePath(), 'utf8');
  }

  writeText(text: string): BasesMap {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new Error(`JSON inválido: ${(err as Error).message}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('El JSON debe ser un objeto en la raíz.');
    }
    const dir = this.config.deviaDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.filePath(), text);
    return parsed as BasesMap;
  }
}
