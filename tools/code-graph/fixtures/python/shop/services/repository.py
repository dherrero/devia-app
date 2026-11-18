from abc import ABC, abstractmethod

from shop.core.errors import NotFoundError


class Repository(ABC):
    @abstractmethod
    def get(self, ident):
        raise NotImplementedError

    @abstractmethod
    def save(self, item):
        raise NotImplementedError


class InMemoryRepository(Repository):
    def __init__(self):
        self._items = {}

    def get(self, ident):
        if ident not in self._items:
            raise NotFoundError(ident)
        return self._items[ident]

    def save(self, item):
        self._items[item.ident] = item

    def all(self):
        return list(self._items.values())
