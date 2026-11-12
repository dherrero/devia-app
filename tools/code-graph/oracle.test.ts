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
 * Recall floor for `calls`, per language, below the spec's 90%. Every missing
 * call measured on the fixtures is a call on a receiver whose type must be
 * inferred (`this.repo.save()`, `const log = new Logger(); log.info()`), which
 * Devia's resolver does not do yet: kanban T-515. RATCHET: these only go up;
 * a language with no entry must meet THRESHOLDS.calls. TypeScript/JavaScript got
 * receiver type inference in T-515 phase 1 (39/39 on the fixture) and Java in phase 2
 * (37/37); neither has a floor.
 */
const CALLS_FLOOR: Record<string, number> = {
  python: 63,
  go: 60,
  dart: 41,
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
