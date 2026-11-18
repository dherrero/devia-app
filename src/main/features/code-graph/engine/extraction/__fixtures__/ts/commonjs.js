const r = require('./r');
const { a, b: c } = require('./ab');
require('./side');

class Dog extends Animal {
  legs = 4;

  bark() {
    return 'woof';
  }
}

module.exports = { Dog };
