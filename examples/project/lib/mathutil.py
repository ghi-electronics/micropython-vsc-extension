# A module in a subdirectory, to prove breakpoints work outside main.py.


def scale(value, factor):
    scaled = value * factor
    return scaled


def clamp(value, low, high):
    if value < low:
        return low
    if value > high:
        return high
    return value
