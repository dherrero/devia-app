from .handlers import handle_pay, handle_register


class Router:
    def __init__(self, users, orders):
        self.routes = {
            "register": lambda args: handle_register(users, *args),
            "pay": lambda args: handle_pay(orders, *args),
        }

    def dispatch(self, command, args):
        route = self.routes.get(command)
        if route is None:
            return not_found(command)
        return route(args)


def not_found(command):
    return 404, command
