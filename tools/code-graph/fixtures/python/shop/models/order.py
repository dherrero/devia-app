from dataclasses import dataclass, field

from .base import Entity, Timestamped


@dataclass
class OrderLine:
    sku: str
    quantity: int
    unit_price: int


def line_total(line):
    return line.quantity * line.unit_price


class Order(Entity, Timestamped):
    def __init__(self, ident, owner):
        super().__init__(ident)
        self.owner = owner
        self.lines = []
        self.status = "open"

    def add_line(self, line):
        self.lines.append(line)

    def total(self):
        return sum(line_total(l) for l in self.lines)

    def mark_paid(self):
        self.status = "paid"
        self.touch(0)

    def kind(self):
        return "order"
