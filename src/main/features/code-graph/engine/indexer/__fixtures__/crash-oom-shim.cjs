require('./crash-common.cjs')();
const hog = [];
setTimeout(() => {
  for (;;) hog.push(new Array(1_000_000).fill(hog.length));
}, 20);
