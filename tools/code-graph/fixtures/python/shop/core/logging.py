LEVELS = ("debug", "info", "warn")


def format_line(scope, message):
    return "[%s] %s" % (scope, message)


class Logger:
    def __init__(self, scope, level="info"):
        self.scope = scope
        self.level = level

    def info(self, message):
        self._write("info", message)

    def warn(self, message):
        self._write("warn", message)

    def child(self, scope):
        return Logger(self.scope + ":" + scope, self.level)

    def _write(self, level, message):
        if LEVELS.index(level) >= LEVELS.index(self.level):
            print(format_line(self.scope, message))
