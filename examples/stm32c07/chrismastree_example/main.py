# DUELink SPTree-B Christmas tree demo on STM32C071.
#
# Random-colour LED animation on the tree plus Jingle Bells on a piezo buzzer.
# Both run cooperatively from a single loop -- neither blocks the other.
#
# Schematic: https://www.duelink.com/sch/gdl-sptree-b.pdf
# The tree carries 26 APA102/SK9822-style addressable RGB LEDs driven over
# SPI (clock + data only -- no per-LED chip select).  Wire the board like:
#
#   Board pin       Peripheral
#   PB3   SCK  -->  Tree CLK
#   PB5   MOSI -->  Tree DIN
#   PA0   PWM  -->  Buzzer +
#   3V3        -->  Tree VCC
#   GND        -->  Tree GND, Buzzer -
#
# The board's default SPI1 pins are PB3/PB4/PB5 and match the DueLink product
# line, so machine.SPI(1) with no pin args uses the right pins natively.
#
# APA102 wire protocol (per LED, MSB first):
#
#   Start frame:   4 x 0x00
#   Each LED:      [0xE0 | brightness(5-bit)]  [B]  [G]  [R]
#   End frame:     4 x 0xFF  (also serves as at least NUM_LED/2 clock
#                  cycles to latch the last LED in long chains)

from machine import SPI, Pin, PWM
import time

NUM_LED = 26

# Full frame = start(4) + N*(4 bytes/LED) + end(4).  Allocated once and
# reused; set_led() mutates in place, show_led() blasts it over SPI.
BUFF_LEN = 4 + NUM_LED * 4 + 4
led_data = bytearray(BUFF_LEN)

# Trailing end frame: at least 32 clock cycles of 1s.  Set once, never
# changes -- the start frame is already all zeros from bytearray init.
for i in range(BUFF_LEN - 4, BUFF_LEN):
    led_data[i] = 0xFF


def set_led(index, color, level):
    """Set LED at 1-based `index` to 24-bit `color` (0xRRGGBB) with
    5-bit `level` (0..31).  Does not transmit -- call show_led() after."""
    if index < 1 or index > NUM_LED:
        return
    off = 4 + (index - 1) * 4
    led_data[off + 0] = 0xE0 | (level & 0x1F)
    led_data[off + 1] = color & 0xFF          # B
    led_data[off + 2] = (color >> 8) & 0xFF   # G
    led_data[off + 3] = (color >> 16) & 0xFF  # R


def show_led(spi):
    """Push the full frame to the tree over SPI in one write."""
    spi.write(led_data)


# 8 MHz matches the Arduino sample; APA102 is spec'd up to 20 MHz but 8 is
# comfortably safe and matches the reference implementation.  Mode 0
# (CPOL=0, CPHA=0) is what APA102 expects.
spi = SPI(1, baudrate=8_000_000, polarity=0, phase=0)

# Blank the tree first so no stray state from a previous run shows up.
for i in range(1, NUM_LED + 1):
    set_led(i, 0, 0)
show_led(spi)
time.sleep_ms(50)


# ---- Colour palette + tiny random -------------------------------------------
# The STM32C071 build strips the `random` module (24 KB RAM budget) and turns
# long-int support off (MICROPY_LONGINT_IMPL_NONE), so ints are limited to the
# 30-bit small-int range. A classic 31-bit LCG multiplier overflows that on
# the very first step, so this uses a 16-bit xorshift instead: shifts + XOR,
# result masked back into 16 bits, everything comfortably inside the small-int
# window. Good enough randomness to pick a colour from an 8-entry palette.
COLORS = (
    0xFF0000,  # red
    0xFF7F00,  # orange
    0xFFFF00,  # yellow
    0x00FF00,  # green
    0x00FFFF,  # cyan
    0x0000FF,  # blue
    0x8B00FF,  # violet
    0xFFFFFF,  # white
)
BRIGHTNESS = 4   # 4/31 ~ 13%; bright enough to see, gentle on the eyes

_seed = 0xACE1   # any non-zero 16-bit value; zero would lock the xorshift

def rand():
    global _seed
    x = _seed
    x = (x ^ (x << 7)) & 0xFFFF
    x = x ^ (x >> 9)
    x = (x ^ (x << 8)) & 0xFFFF
    _seed = x
    return x


# ---- Buzzer on PA0 ----------------------------------------------------------
# PA0 = TIM2_CH1 on STM32C071. machine.PWM finds the timer channel from the
# pin's alt-function table (ghiboards/GHI_STM32C071 uses a patched
# stm32c071_af.csv that includes PA0's TIM2_CH1 at AF2 -- the upstream copy
# omits it).
buzzer = PWM(Pin('A0'))
buzzer.duty_u16(0)   # start silent


def play_note(freq):
    """Drive the buzzer at `freq` Hz, or silence when freq == 0."""
    if freq == 0:
        buzzer.duty_u16(0)
    else:
        buzzer.freq(freq)
        buzzer.duty_u16(32768)   # 50 % duty for a plain square wave


# Jingle Bells: (freq_hz, duration_ms) pairs. freq = 0 is a rest.
FREQ_DUR = (
    330, 200, 330, 200, 330, 300,   0, 100,
    330, 200, 330, 200, 330, 300,   0, 100,
    330, 200, 392, 200, 262, 300, 294, 100,
    330, 400,   0, 400, 349, 200, 349, 200,
    349, 300,   0,   0, 349, 100, 349, 200,
    330, 200, 330, 200,   0,   0, 330, 100,
    330, 100, 392, 200, 392, 200, 349, 200,
    294, 200, 262, 400,   0, 400,
)


# ---- Cooperative main loop --------------------------------------------------
# One loop drives two timelines. Both events are scheduled against ticks_ms(),
# so a slow SPI blast or note change slips its own timeline but never delays
# the other. The small sleep at the bottom keeps CPU idle when nothing is due
# without pushing note timing past the shortest musical interval (~100 ms).

LED_STEP_MS = 200   # how often the LED colours change

song_idx = 0
now = time.ticks_ms()
next_led = now
next_note = now

print("Tree ready. Playing Jingle Bells while blinking randomly.")

while True:
    now = time.ticks_ms()

    # LED tick: recolour every LED with a random palette entry.
    if time.ticks_diff(now, next_led) >= 0:
        for i in range(1, NUM_LED + 1):
            set_led(i, COLORS[rand() % len(COLORS)], BRIGHTNESS)
        show_led(spi)
        next_led = time.ticks_add(now, LED_STEP_MS)

    # Song tick: advance to the next (freq, duration) pair.
    if time.ticks_diff(now, next_note) >= 0:
        freq = FREQ_DUR[song_idx]
        dur  = FREQ_DUR[song_idx + 1]
        play_note(freq)
        # A duration of 0 in the source data is a data-alignment artefact --
        # nudge it to 1 so the note timer moves on instead of parking here.
        next_note = time.ticks_add(now, dur if dur > 0 else 1)
        song_idx = (song_idx + 2) % len(FREQ_DUR)

    # Yield: short enough that the shortest note (~100 ms) is still on time,
    # long enough that we do not busy-spin between events.
    time.sleep_ms(10)
