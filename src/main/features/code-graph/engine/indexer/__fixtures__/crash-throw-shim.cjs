require('./crash-common.cjs')();
setTimeout(() => {
  throw new Error('boom');
}, 20);
