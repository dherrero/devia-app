class EventBus:
    def __init__(self):
        self._handlers = []

    def subscribe(self, handler):
        self._handlers.append(handler)
        return lambda: self.unsubscribe(handler)

    def unsubscribe(self, handler):
        self._handlers.remove(handler)

    def publish(self, payload):
        for handler in list(self._handlers):
            handler(payload)
