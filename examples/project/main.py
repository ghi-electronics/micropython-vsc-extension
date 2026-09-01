# Multi-file sample: a package in a subdirectory.
#
#   main.py          this file, the entry point
#   lib/mathutil.py  a module it imports
#
# Press F5, then set a breakpoint in lib/mathutil.py on line 5 (scaled = ...).
#
# What to expect:
#   - both files are deployed, lib/ created on the device
#   - the breakpoint hits inside the module, not just in main.py
#   - the Call Stack shows  scale()  <-  process()  <-  (module),
#     with the top frame opening lib/mathutil.py rather than main.py
#
# This is what breakpoint matching by full path buys: lib/mathutil.py is a
# different file from any other util.py in the project.

import time

from lib import mathutil


def process(n):
    scaled = mathutil.scale(n, 3)
    limited = mathutil.clamp(scaled, 0, 20)
    return limited


value = 0
while True:
    result = process(value)
    print("value", value, "->", result)
    value = value + 1
    time.sleep_ms(400)
