// Lets vitest run the real TypeScript seed worker entry inside a worker_thread.
require('tsx/cjs');
require('../seed-copy-worker.ts');
