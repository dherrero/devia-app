// A worker that dies before taking any lock.
setTimeout(() => process.exit(1), 100);
