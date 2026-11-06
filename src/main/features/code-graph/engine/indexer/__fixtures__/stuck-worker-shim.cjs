// A worker that takes the lock, starts a building DB and then ignores cancel requests.
require('tsx/cjs');
const fs = require('node:fs');
const path = require('node:path');
const { workerData } = require('node:worker_threads');
const { acquireWriterLock } = require('../../db/writer-lock.ts');

acquireWriterLock(workerData.dataDir, 'indexer');
fs.writeFileSync(path.join(workerData.dataDir, 'graph.db.building'), 'partial');
setInterval(() => {}, 1000);
