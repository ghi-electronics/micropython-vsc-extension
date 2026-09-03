# Sample program for the MicroPython debugger.
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
# Nothing board-specific here, so it runs on SITCore, Pico 2 and ESP32-S2 alike.
# Keep the line numbers: the notes above and dap_sequence_test.js refer to them.

import time


DELAY_MS = 500


def next_count(n):
    step = 1
    total = n + step
    return total


def blink(n):
    doubled = n * 2
    n = next_count(n)
    print("count is", n)
    return n


count = 0
while True:
    count = blink(count)
    time.sleep_ms(DELAY_MS)
