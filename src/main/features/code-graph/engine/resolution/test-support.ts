import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  EdgeKind,
  GraphNode,
  NodeKind,
} from '../../../../../shared/domain/code-graph';
import { openGraphDb, type GraphDb } from '../db/connection';
import { GraphQueries, type UnresolvedRef } from '../db/queries';
import {
  createParser,
  grammarVariantForPath,
  languageForPath,
} from '../extraction/grammars';
import { makeNodeId } from '../extraction/node-id';
import { extractorFor } from '../extraction/registry';

/** Temp project tree + real extractors + real SQLite, for resolver end-to-end tests. */
export interface Harness {
  root: string;
  q: GraphQueries;
  addFiles(files: Record<string, string>): Promise<void>;
  sym(file: string, qualifiedName: string, kind?: NodeKind): GraphNode;
  fileId(file: string): string;
  targets(sourceId: string, kind: EdgeKind): string[];
  failedRefs(): UnresolvedRef[];
  close(): void;
}

function required<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) throw new Error(`missing ${what}`);
  return value;
}

export function createHarness(): Harness {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-lang-root-'));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-lang-data-'));
  const db: GraphDb = openGraphDb(path.join(dataDir, 'graph.db'));
  const q = new GraphQueries(db);

  async function addFiles(files: Record<string, string>): Promise<void> {
    for (const [rel, source] of Object.entries(files)) {
      const abs = path.join(root, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, source);
      const lang = languageForPath(rel);
      if (!lang) continue;
      const extractor = required(extractorFor(lang), `extractor for ${lang}`);
      const parser = await createParser(lang, grammarVariantForPath(rel));
      const tree = required(parser.parse(source), 'tree');
      try {
        const ex = extractor.extract(rel, source, tree);
        q.transaction(() => {
          q.upsertFile({
            path: rel,
            contentHash: 'h',
            language: lang,
            size: source.length,
            modifiedAt: 1,
            indexedAt: 1,
            nodeCount: ex.nodes.length,
            generated: false,
            isTest: false,
          });
          q.insertNodes(ex.nodes);
          q.insertEdges(ex.edges);
          q.insertUnresolved(ex.unresolved);
        });
      } finally {
        tree.delete();
        parser.delete();
      }
    }
  }

  return {
    root,
    q,
    addFiles,
    sym(file, qualifiedName, kind) {
      // Some extractors prefix qualified names with the module/package path.
      const found = q
        .nodesInFile(file)
        .filter(
          (n) =>
            (n.qualifiedName === qualifiedName ||
              n.qualifiedName.endsWith(`.${qualifiedName}`)) &&
            (kind === undefined || n.kind === kind),
        );
      if (found.length !== 1)
        throw new Error(
          `expected one ${qualifiedName} in ${file}, got ${found.length}`,
        );
      return required(found[0], qualifiedName);
    },
    fileId: (file) => makeNodeId(file, 'file', file, 1),
    targets: (sourceId, kind) =>
      q.edgesFrom(sourceId, [kind]).map((e) => e.target),
    failedRefs: () => q.unresolvedByStatus('failed'),
    close() {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
