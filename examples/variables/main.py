# Variable inspection sample.
#
# Set a breakpoint on line 26 (total = n + 1) and press F5.
#
# In the Variables panel, under Globals:
#   - readings and nested have an expand arrow; open them
#   - nested contains a list and a dict, so it expands two levels
#   - config expands to its keys
#   - count and total are leaves and show no arrow
#
# The Watch panel and the Debug Console prompt both evaluate expressions in
# the halted frame, so try:  len(readings)   or   config["pin"] * 2
#
# Note the Variables panel shows Globals only. Local variable names do not
# exist in upstream MicroPython bytecode, so n and total are not listed --
# though evaluating them by name in Watch does work.

import time

readings = [10, 20, 30]
config = {"name": "sensor", "pin": 7, "scale": 1.5}
nested = [[1, 2], {"a": 1}]


def sample(n):
    total = n + 1
    readings.append(total)
    return total


count = 0
while True:
    count = sample(count)
    print("count", count, "readings", len(readings))
    time.sleep_ms(500)
