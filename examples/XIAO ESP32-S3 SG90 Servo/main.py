# Sweeps an SG90 mini servo back and forth on pin D10 of the XIAO ESP32-S3.
#
# Wiring:
#   Servo brown (or black)   -- XIAO GND
#   Servo red                -- XIAO 5V   (USB power; do not use 3V3)
#   Servo orange (or yellow) -- XIAO D10  (GPIO 9)
#
# Press F5. The horn should step 0 -> 45 -> 90 -> 135 -> 180 and back.
#
# Set a breakpoint inside the `for` loop below (on set_angle) and press F5
# repeatedly: the horn stays still while the debugger is stopped, then
# jumps to the next angle on continue. That is the most satisfying way to
# confirm F5 is driving the real board rather than running on the PC.

from machine import Pin, PWM
import time

SERVO_PIN = 9              # D10 on XIAO ESP32-S3
FREQ_HZ = 50
PERIOD_US = 1_000_000 // FREQ_HZ

# SG90 responds to pulses from ~0.5 ms (0 deg) to ~2.5 ms (180 deg).
# Servos vary a little; if the horn buzzes or jitters at the ends,
# narrow the range slightly (e.g. 700..2300).
MIN_US = 500
MAX_US = 2500

servo = PWM(Pin(SERVO_PIN), freq=FREQ_HZ)


def set_angle(deg):
    if deg < 0:
        deg = 0
    elif deg > 180:
        deg = 180
    pulse_us = MIN_US + (MAX_US - MIN_US) * deg // 180
    duty = pulse_us * 65535 // PERIOD_US
    servo.duty_u16(duty)


while True:
    for angle in (0, 45, 90, 135, 180, 135, 90, 45):
        set_angle(angle)
        time.sleep_ms(400)
