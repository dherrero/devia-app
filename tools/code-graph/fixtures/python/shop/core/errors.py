class DomainError(Exception):
    code = "DOMAIN"

    def __init__(self, message):
        super().__init__(message)
        self.message = message


class NotFoundError(DomainError):
    code = "NOT_FOUND"

    def __init__(self, what):
        super().__init__(describe_missing(what))


def describe_missing(what):
    return "%s not found" % what


def is_domain_error(err):
    return isinstance(err, DomainError)
