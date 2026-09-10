# Cycles the on-board RGB LED through white, red, green, blue, one second each.
#
# Written for the HiLetgo-style ESP32-S3 N16R8 devkit, which puts a WS2812
# addressable LED on GPIO 48. Some other ESP32-S3 boards use GPIO 38 (Waveshare)
# or 39 (Adafruit QT Py). Edit LED_PIN if the LED does not light.
#
# Good place for a breakpoint: line 31, led.write(). Set it, press F5, then F10
# to step over -- the LED changes colour while the debugger is stopped, which
# is a nice reminder that F5 is not a simulator.

import neopixel
from machine import Pin
import time

LED_PIN = 48
DELAY_MS = 1000
BRIGHTNESS = 64            # 0..255; full 255 is genuinely uncomfortable to look at

led = neopixel.NeoPixel(Pin(LED_PIN), 1)

COLOURS = (
    ("white", (BRIGHTNESS, BRIGHTNESS, BRIGHTNESS)),
    ("red",   (BRIGHTNESS, 0, 0)),
    ("green", (0, BRIGHTNESS, 0)),
    ("blue",  (0, 0, BRIGHTNESS)),
)

while True:
    for name, rgb in COLOURS:
        led[0] = rgb
        led.write()
        print(name)
        time.sleep_ms(DELAY_MS)
