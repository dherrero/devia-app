"""Animal module docs."""
import abc


class Animal(Base, abc.ABC, metaclass=Meta):
    """An animal.

    Lives in the zoo.
    """

    def __init__(self, name):
        self.name = name

    async def run(self):
        await self.helper()
        return other(self.name)

    @staticmethod
    def create():
        return Animal("x")

    def _hidden(self):
        pass

    def __secret(self):
        pass

    class Inner:
        def go(self):
            pass


def top():
    """Top docs."""
    util.work()
