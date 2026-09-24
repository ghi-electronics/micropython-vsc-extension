# Blink the on-board LED on an ESP32-PICO-DevKitM.
#
# The DevKit's on-board LED sits on GPIO2. Wiring for anything else is:
#
#   GPIO2 --> LED --> resistor --> GND
#
# The DevKit reaches VS Code through a CH340/CP2102 USB-to-serial bridge, so
# .vscode/launch.json sets debugInterface: "uart" (see below) and the debug
# protocol travels over UART0 at 115200 baud alongside program output.

from machine import Pin
import time

LED_PIN = 2
DELAY_MS = 500

led = Pin(LED_PIN, Pin.OUT)

print("Blinking GPIO", LED_PIN)

count = 0
while True:
    led.value(1)
    time.sleep_ms(DELAY_MS)
    led.value(0)
    time.sleep_ms(DELAY_MS)
    count += 1
    print("blink", count)
