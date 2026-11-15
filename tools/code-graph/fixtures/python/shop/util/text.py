import re


def slugify(value):
    return collapse_dashes(re.sub(r"[^a-z0-9]+", "-", value.lower()))


def collapse_dashes(value):
    return re.sub(r"-+", "-", value).strip("-")


def normalise_email(email):
    return email.strip().lower()
