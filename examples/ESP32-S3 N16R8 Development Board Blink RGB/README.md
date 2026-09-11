# ESP32-S3 N16R8 Development Board -- Blink RGB

Cycles the on-board RGB LED through **white -> red -> green -> blue**, one
second each. Written for the dual-USB "ESP32-S3 N16R8 Development Board"
sold on Amazon, and works on any close relative that puts a WS2812
addressable LED on GPIO 48.

Press **F5**. Nothing to install -- `neopixel` ships with MicroPython.

## If the LED does not light

The LED pin is not standard. Common values:

| Board | GPIO |
|---|---|
| HiLetgo ESP32-S3 N16R8 devkit | **48** (default) |
| Waveshare ESP32-S3-Zero | 21 |
| Waveshare ESP32-S3-Pico | 38 |
| Adafruit QT Py ESP32-S3 | 39 (data on 39, power on 38) |

Edit `LED_PIN` at the top of `main.py`. On the QT Py, `Pin(38, Pin.OUT).value(1)`
first, so the NeoPixel gets power.

## Debugging it

`main.py` line 31 is `led.write()` inside the `show()` function -- the moment the new colour reaches the
LED. Set a breakpoint there, press F5, then **F10** to step over: the LED
changes colour while the debugger is stopped. That is one of the more
satisfying demonstrations that F5 is driving the real board rather than
running the file on the PC.

Hover `rgb` on line 30 to see the value; expand `led` in the Variables pane
to see the underlying `buf`.
