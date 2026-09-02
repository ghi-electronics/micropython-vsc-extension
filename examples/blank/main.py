# Sample program for the MicroPython SITCore debugger.
#
# Open this folder in VS Code and press F5.
# Set a breakpoint by clicking the gutter next to line 32, led.toggle().
#
# What to expect:
#   - the file is deployed and the board restarts
#   - execution halts on line 32
#   - the Call Stack shows  blink()  <-  (module)
#   - F10 (step over) moves to line 33 without entering next_count()
#   - F11 (step in) on line 33 enters next_count() at line 26
#   - Shift+F11 (step out) returns to blink()
#   - F5 (continue) runs on, and the print() on line 34 appears in the
#     Debug Console
#
# The Variables panel stays empty on purpose: variable inspection is not
# implemented yet.

import pyb
import time

led = pyb.LED(1)


def next_count(n):
    step = 1
    total = n + step
    return total


def blink(n):
    led.toggle()
    n = next_count(n)
    print("count is", n)
    return n


count = 0
while True:
    count = blink(count)
    time.sleep_ms(500)
