import * as fs from 'node:fs';
import type { Parser } from 'web-tree-sitter';
import type { CodeGraphLanguage } from '../../../../../shared/domain/code-graph';
import type { GraphDb } from '../db/connection';
import type { FileRow, GraphQueries } from '../db/queries';
import type { DiscoveredFile } from '../discovery/discover';
import { isTestFile } from '../discovery/test-detection';
import type { FileExtraction } from '../extraction/extractor';
import { isGeneratedFile } from '../extraction/generated-detection';
import { createParser, grammarVariantForPath, languageForPath } from '../extraction/grammars';
import { extractorFor } from '../extraction/registry';
import { contentHash } from './hash';

const GENERATED_HEAD_BYTES = 2048;

export type FileOutcome =
  | { kind: 'ok'; row: FileRow; extraction: FileExtraction }
  | { kind: 'failed'; row: FileRow }
  | { kind: 'unreadable' };

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function isSupported(rel: string): boolean {
  const lang = languageForPath(rel);
  return lang !== undefined && extractorFor(lang) !== undefined;
}

export class ParserPool {
  private readonly parsers = new Map<string, Promise<Parser>>();

  get(lang: CodeGraphLanguage, variant: 'tsx' | undefined): Promise<Parser> {
    const key = `${lang}:${variant ?? ''}`;
    let p = this.parsers.get(key);
    if (!p) {
      p = createParser(lang, variant);
      this.parsers.set(key, p);
    }
    return p;
  }

  async dispose(): Promise<void> {
    for (const p of this.parsers.values()) {
      try {
        (await p).delete();
      } catch {
        // a parser that failed to load has nothing to free
      }
    }
    this.parsers.clear();
  }
}

/** Reads, hashes and extracts one file; shared by the full index and the incremental sync. */
export async function extractFile(file: DiscoveredFile, pool: ParserPool): Promise<FileOutcome> {
  const lang = languageForPath(file.relPath);
  const extractor = lang ? extractorFor(lang) : undefined;
  if (!lang || !extractor) return { kind: 'unreadable' };
  let buf: Buffer;
  try {
    buf = await fs.promises.readFile(file.absPath);
  } catch {
    return { kind: 'unreadable' };
  }
  const isTest = isTestFile(file.relPath, lang);
  const row: FileRow = {
    path: file.relPath,
    contentHash: contentHash(buf),
    language: lang,
    size: buf.length,
    modifiedAt: Math.round(file.mtimeMs),
    indexedAt: Date.now(),
    nodeCount: 0,
    generated: isGeneratedFile(file.relPath, buf.subarray(0, GENERATED_HEAD_BYTES).toString('utf8')),
    isTest,
  };
  try {
    const parser = await pool.get(lang, grammarVariantForPath(file.relPath));
    const source = buf.toString('utf8');
    const tree = parser.parse(source);
    if (!tree) return { kind: 'failed', row: { ...row, errors: ['parser returned no tree'] } };
    let extraction: FileExtraction;
    try {
      extraction = extractor.extract(file.relPath, source, tree);
    } finally {
      tree.delete();
    }
    if (isTest) for (const n of extraction.nodes) n.isTest = true;
    row.nodeCount = extraction.nodes.length;
    if (extraction.errors.length > 0) row.errors = extraction.errors;
    return { kind: 'ok', row, extraction };
  } catch (err) {
    return { kind: 'failed', row: { ...row, errors: [errorMessage(err)] } };
  }
}

// One SAVEPOINT per file so a single bad file (e.g. a reference to a node id that was
// deduplicated away) is dropped without rolling back the whole batch.
export function writeExtraction(
  db: GraphDb,
  q: GraphQueries,
  outcome: FileOutcome & { kind: 'ok' },
): boolean {
  db.exec('SAVEPOINT index_file');
  try {
    q.upsertFile(outcome.row);
    q.insertNodes(outcome.extraction.nodes);
    q.insertEdges(outcome.extraction.edges);
    q.insertUnresolved(outcome.extraction.unresolved);
    db.exec('RELEASE index_file');
    return true;
  } catch (err) {
    db.exec('ROLLBACK TO index_file');
    db.exec('RELEASE index_file');
    q.upsertFile({ ...outcome.row, nodeCount: 0, errors: [errorMessage(err)] });
    return false;
  }
}
