from ..models import create_user
from ..util import text
from .repository import InMemoryRepository


class UserService:
    def __init__(self, log):
        self.log = log
        self.repo = InMemoryRepository()

    def register(self, name, email):
        user = create_user(text.slugify(name), name, email)
        self.repo.save(user)
        self.log.info("registered " + user.ident)
        return user

    def find(self, ident):
        return self.repo.get(ident)
