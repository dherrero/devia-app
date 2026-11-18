// Lets vitest run the real TypeScript worker entry inside a worker_thread.
require('tsx/cjs');
require('../index-worker.ts');
