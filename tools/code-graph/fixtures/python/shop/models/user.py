from .base import Entity
from ..util.text import normalise_email


class User(Entity):
    def __init__(self, ident, name, email):
        super().__init__(ident)
        self.name = name
        self.email = email

    def kind(self):
        return "user"


def create_user(ident, name, email):
    return User(ident, name, normalise_email(email))
