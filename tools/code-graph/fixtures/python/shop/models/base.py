class Entity:
    def __init__(self, ident):
        self.ident = ident

    def key(self):
        return "%s:%s" % (self.kind(), self.ident)

    def kind(self):
        return "entity"


class Timestamped:
    def touch(self, now):
        self.updated_at = now
        return self
