// Runs a real full index in a separate process and says when it is mid-parse, so a test can
// kill the whole process (no finally, no exit hook) and look at what it leaves behind.
require('tsx/cjs');
const { indexProject } = require('../orchestrator.ts');

const [root, dataDir] = process.argv.slice(2);
let told = false;
indexProject({
  root,
  dataDir,
  batchSize: 1,
  onProgress: (p) => {
    if (!told && p.phase === 'parse' && p.filesDone >= 2) {
      told = true;
      process.stdout.write('parsing\n');
      // Hold the event loop busy-ish but alive until killed.
      setInterval(() => undefined, 1000);
    }
  },
}).then(
  () => process.stdout.write('done\n'),
  (err) => process.stdout.write(`error ${err && err.message}\n`),
);
