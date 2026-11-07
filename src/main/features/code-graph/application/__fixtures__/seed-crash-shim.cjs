// Dies after leaving a half-written temp file, like a crash mid-copy.
const fs = require('node:fs');
const { workerData } = require('node:worker_threads');
fs.writeFileSync(workerData.tmp, 'half');
fs.writeFileSync(`${workerData.tmp}-wal`, 'half');
throw new Error('seed worker boom');
