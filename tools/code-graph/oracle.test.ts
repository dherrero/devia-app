import { describe, expect, it } from 'vitest';
import { indexProject } from '../../src/main/features/code-graph/engine/indexer/orchestrator';
// @ts-expect-error plain ESM tool script, no type declarations
import { formatResult, LANGUAGES, runOracle, THRESHOLDS } from './oracle.mjs';

// Parity oracle against the reference tool codegraph (S-44 T-507).
//
// Needs a BUILT codegraph, which is not a dependency of this repo, so the suite
// only runs when CODEGRAPH_ORACLE_BIN points at its `dist/bin/codegraph.js`:
//
//   CODEGRAPH_ORACLE_BIN=/path/to/codegraph/dist/bin/codegraph.js \
//     npx vitest run --config vitest.config.ts tools/code-graph/oracle.test.ts
//
// Without it every case is skipped (it.skip), so `npm run test:main` stays
// hermetic. The same comparison is available as a CLI with full diffs:
// `node tools/code-graph/oracle.mjs --lang all --verbose`.

const BIN = process.env['CODEGRAPH_ORACLE_BIN'];

/**
 * Recall floor for `calls`, per language: the value each fixture really reaches
 * once receiver type inference (kanban T-515: TS in phase 1; Java, Go, Dart and
 * Python in phase 2) follows fields, locals, parameters and declared/inferred
 * return types. RATCHET: these only go up, and none may sit under
 * THRESHOLDS.calls (90). Python is measured after the oracle's NAME_GUESS_EDGES
 * normalisation (4 untyped-receiver guesses codegraph makes by method or
 * variable name; raw recall 32/36 = 88.9%).
 */
const CALLS_FLOOR: Record<string, number> = {
  ts: 100,
  python: 100,
  java: 100,
  go: 100,
  dart: 100,
};

interface Score {
  pct: number;
}
interface OracleResult {
  calls: Score;
  imports: Score;
  symbols: Score;
}

const run = BIN ? it : it.skip;

describe('code graph parity with codegraph', () => {
  for (const lang of LANGUAGES as string[]) {
    run(
      `${lang}: imports and symbols meet the S-44 thresholds, calls holds its floor`,
      async () => {
        const result = (await runOracle({
          lang,
          codegraphBin: BIN,
          indexOurs: (root: string, dataDir: string) => indexProject({ root, dataDir }),
        })) as OracleResult;
        const report = formatResult(lang, result, true);
        expect(result.imports.pct, report).toBeGreaterThanOrEqual(THRESHOLDS.imports);
        expect(result.symbols.pct, report).toBeGreaterThanOrEqual(THRESHOLDS.symbols);
        expect(result.calls.pct, report).toBeGreaterThanOrEqual(CALLS_FLOOR[lang] ?? THRESHOLDS.calls);
      },
      300_000,
    );
  }
});
