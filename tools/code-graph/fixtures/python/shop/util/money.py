def round_to(value, digits):
    factor = 10 ** digits
    return round(value * factor) / factor


def format_money(cents):
    return "%s EUR" % round_to(cents / 100, 2)
