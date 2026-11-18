// Runs the real TypeScript server entry as a child process under tsx, and reports on exit
// whether the tree-sitter engine was loaded (it must stay lazy: only a sync needs it).
require('tsx/cjs');
process.on('exit', () => {
  const loaded = Object.keys(require.cache).some((k) => k.includes('web-tree-sitter'));
  process.stderr.write(`[shim] web-tree-sitter loaded: ${loaded}\n`);
});
require('../server.ts');
