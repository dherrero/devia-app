import functools

MAX_SIZE = 10
counter = 0
double = lambda x: x * 2

setup()


@app.route('/x')
@functools.lru_cache(maxsize=1)
def handler(req):
    def inner():
        deep()
    items = [convert(i) for i in req]
    return render(items)


if TYPE_CHECKING:
    from typing import Any

    def checked():
        pass

try:
    FALLBACK = 1
except ImportError:
    def fallback():
        pass

for _i in range(3):
    LOOP_CONST = _i

if __name__ == '__main__':
    main()
