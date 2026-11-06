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
