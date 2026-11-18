if (ready) {
  const inBlock = 1;
  function blockFn() {}
}

for (let i = 0; i < 3; i++) {
  tick(i);
}

try {
  const attempt = run();
} catch (err) {
  const failure = err;
}

describe('suite', () => {
  const helper = () => {};
  helper();
});

app.get('/', function () {
  let tmp = 1;
});

export function outer() {
  const local = 1;
  function inner() {
    deep();
  }
  if (local) {
    function hidden() {}
  }
  inner();
}

const o = {
  m() {
    ping();
  },
  value: 1,
};

register({
  n() {},
});

const A = class extends Base {
  m() {}
};

use(class {
  z() {}
});

type Shape = { area(): number; side: number };
