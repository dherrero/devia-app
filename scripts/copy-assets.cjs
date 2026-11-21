const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const pairs = [
  [
    'src/main/features/code-graph/engine/extraction/wasm',
    'dist/main/main/features/code-graph/engine/extraction/wasm',
  ],
  [
    'src/main/features/code-graph/engine/db',
    'dist/main/main/features/code-graph/engine/db',
  ],
];

for (const [from, to] of pairs) {
  const src = path.join(root, from);
  const dst = path.join(root, to);
  fs.mkdirSync(dst, { recursive: true });
  for (const f of fs.readdirSync(src)) {
    if (f.endsWith('.wasm') || f.endsWith('.sql'))
      fs.copyFileSync(path.join(src, f), path.join(dst, f));
  }
}

// S-50: the script checker's TypeScript lib declarations, as JSON. electron-builder's
// `!**/*.ts` rule strips every `.d.ts` from the package, so the checker cannot read
// them from the typescript package inside the installed app. Needs the compiled
// helper, so it runs after `tsc`.
{
  const helper = path.join(root, 'dist/main/main/features/code-mode/infrastructure/ts-libs.js');
  const { collectTsLibs, readTypescriptLib } = require(helper);
  const libDir = path.dirname(require.resolve('typescript/lib/typescript.js'));
  const libs = collectTsLibs(readTypescriptLib(libDir));
  fs.writeFileSync(path.join(path.dirname(helper), 'ts-libs.json'), JSON.stringify(libs));
  console.log(`[copy-assets] ts-libs.json: ${Object.keys(libs).length} files`);
}
