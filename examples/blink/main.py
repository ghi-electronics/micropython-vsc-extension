# Sample program for the MicroPython debugger.
#
# Open this folder in VS Code and press F5.
# Set a breakpoint by clicking the gutter next to line 32, led.value(1).
#
# What to expect:
#   - the file is deployed and the board restarts
#   - execution halts on line 32
#   - the Call Stack shows  blink()  <-  (module)
#   - F10 (step over) moves to line 33 without entering next_count()
#   - F11 (step in) on line 33 enters next_count() at line 41
#   - Shift+F11 (step out) returns to blink()
#   - F5 (continue) runs on, and the print() on line 34 appears in the
#     Debug Console
#
# Keep the line numbers: the notes above, dap_sequence_test.js and
# concurrent_test.js all refer to line 32.

from machine import Pin
import time

# The LED pin on your board -- edit this line.  Pico and Pico 2 use 25, the
# Seeed XIAO ESP32-S3 uses 21.  A QT Py RP2040 has no plain LED (only a
# NeoPixel, data 12 and power 11) and a generic ESP32-S2 module has none.
LED_PIN = 21
DELAY_MS = 500

#led = Pin(LED_PIN, Pin.OUT)


def blink(n):
    #led.value(1)
    n = next_count(n)
    print("count is", n)
    time.sleep_ms(DELAY_MS)
    #led.value(0)
    return n


def next_count(n):
    step = 1
    total = n + step
    return total


count = 0
while True:
    count = blink(count)
    time.sleep_ms(DELAY_MS)
