def outer():
    def inner():
        pass

    if True:
        def hidden():
            pass

    class Local:
        pass

    value = 1
    return inner
