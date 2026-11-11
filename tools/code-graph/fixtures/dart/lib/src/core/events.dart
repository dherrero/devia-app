typedef Handler<T> = void Function(T event);

class EventBus<T> {
  final List<Handler<T>> _handlers = [];

  void subscribe(Handler<T> handler) {
    _handlers.add(handler);
  }

  void publish(T event) {
    for (final h in _handlers) {
      h(event);
    }
  }
}
