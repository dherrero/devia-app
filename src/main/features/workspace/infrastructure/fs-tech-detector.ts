import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TechDetector } from '../domain/ports';
import type { ConfigRepository } from '../../../shared/ports';
import { TECH_CATALOG, type ProjectTech } from '../../../../shared/domain/tech-catalog';

export class FsTechDetector implements TechDetector {
  constructor(private readonly config: ConfigRepository) {}

  detect(projectPath: string): ProjectTech {
    const { workspaceRoot } = this.config.get();
    if (!workspaceRoot) return 'folder';
    const dir = path.join(workspaceRoot, projectPath);

    // Directory listing is read at most once, lazily — only if an extension
    // glob marker (`*.csproj`) is reached for this project.
    let listing: readonly string[] | null = null;
    const entries = (): readonly string[] => {
      if (listing === null) {
        try {
          listing = fs.readdirSync(dir);
        } catch {
          listing = [];
        }
      }
      return listing;
    };

    for (const { id, markers } of TECH_CATALOG) {
      for (const marker of markers) {
        if (marker.startsWith('*.')) {
          const ext = marker.slice(1); // ".csproj"
          if (entries().some((f) => f.endsWith(ext))) return id;
        } else if (fs.existsSync(path.join(dir, marker))) {
          return id;
        }
      }
    }
    return 'folder';
  }
}
