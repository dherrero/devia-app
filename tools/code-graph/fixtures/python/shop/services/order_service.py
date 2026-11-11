from shop.core.events import EventBus
from shop.models.order import Order
from shop.util.money import format_money as money
from . import repository


class OrderService:
    def __init__(self, users, log):
        self.users = users
        self.log = log
        self.events = EventBus()
        self.repo = repository.InMemoryRepository()

    def open(self, ident, user_id, lines):
        owner = self.users.find(user_id)
        order = Order(ident, owner)
        for line in lines:
            order.add_line(line)
        self.repo.save(order)
        self.events.publish({"order": ident, "kind": "created"})
        return order

    def pay(self, ident):
        order = self.repo.get(ident)
        order.mark_paid()
        amount = money(order.total())
        self.log.warn("paid " + amount)
        return amount
