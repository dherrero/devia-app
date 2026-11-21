import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The TypeScript standard-library declarations the script checker needs (`Promise`,
 * `Array`, `Map`, `JSON`, ...), as plain text.
 *
 * Why they are bundled instead of read from the `typescript` package at run time: the
 * app is packaged with a `!**\/*.ts` rule, which also strips every `.d.ts`, so in the
 * installed app the compiler found no `lib.es2022.d.ts` and every script failed with
 * "Cannot find global type 'Promise'". At build time `scripts/copy-assets.cjs` writes
 * these files into `ts-libs.json` next to the compiled checker, which the checker
 * prefers over the disk.
 */

/** The set of `lib.*.d.ts` the checker's compiler options need, entry point first. */
export const TS_LIBS_ENTRY = 'lib.es2022.d.ts';

/** Reads `lib.<name>.d.ts` from the typescript package's own `lib` directory. */
export function readTypescriptLib(libDir: string): (name: string) => string | undefined {
  return (name) => {
    try {
      return fs.readFileSync(path.join(libDir, name), 'utf8');
    } catch {
      return undefined;
    }
  };
}

/**
 * Follows `/// <reference lib="..." />` from `entry` and returns every file it
 * needs, by file name. A missing file throws: a package that would ship without it
 * must fail the build, not the user's first script.
 */
export function collectTsLibs(read: (name: string) => string | undefined, entry: string = TS_LIBS_ENTRY): Record<string, string> {
  const out: Record<string, string> = {};
  const queue = [entry];
  while (queue.length > 0) {
    const name = queue.pop() as string;
    if (name in out) continue;
    const text = read(name);
    if (text === undefined) throw new Error(`TypeScript lib file not found: ${name}`);
    out[name] = text;
    for (const m of text.matchAll(/\/\/\/\s*<reference\s+lib="([^"]+)"\s*\/>/g)) queue.push(`lib.${(m[1] as string).toLowerCase()}.d.ts`);
  }
  return out;
}
