// Simulates a worker that took the writer lock and started building, then dies on its own.
const fs = require('node:fs');
const path = require('node:path');
const { workerData } = require('node:worker_threads');

module.exports = function startBuilding() {
  fs.writeFileSync(
    path.join(workerData.dataDir, 'writer.lock'),
    JSON.stringify({ pid: process.pid, owner: 'indexer', since: Date.now(), token: 'crash' }),
  );
  fs.writeFileSync(path.join(workerData.dataDir, 'graph.db.building'), 'partial');
};
