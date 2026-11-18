from shop.core import errors


def guard(work):
    try:
        return 200, work()
    except errors.DomainError as err:
        if errors.is_domain_error(err):
            return 404, err.code
        raise


def handle_register(users, name, email):
    return guard(lambda: users.register(name, email).name)


def handle_pay(orders, ident):
    return guard(lambda: orders.pay(ident))
