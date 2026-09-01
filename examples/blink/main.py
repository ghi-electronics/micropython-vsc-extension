# Sample program for the MicroPython SITCore debugger.
#
# Open this folder in the Extension Development Host and press F5.
# Set a breakpoint by clicking the gutter next to line 31, led.toggle().
#
# What to expect:
#   - the file is deployed and the board restarts
#   - execution halts on line 31
#   - the Call Stack shows  blink()  <-  (module)
#   - F10 (step over) moves to line 32 without entering next_count()
#   - F11 (step in) on line 32 enters next_count() at line 25
#   - Shift+F11 (step out) returns to blink()
#   - F5 (continue) runs to the next loop iteration and stops again
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
    return n


count = 0
while True:
    count = blink(count)
    time.sleep_ms(300)
