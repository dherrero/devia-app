from shop.core import Logger
from shop.services import OrderService, UserService
from shop.api.router import Router
import shop.util.text


def build_app():
    log = Logger("app")
    users = UserService(log.child("users"))
    orders = OrderService(users, log.child("orders"))
    orders.events.subscribe(lambda e: log.info(str(e)))
    return Router(users, orders)


def main(argv):
    router = build_app()
    command = shop.util.text.slugify(argv[0]) if argv else "help"
    status, _ = router.dispatch(command, argv[1:])
    return status
