# Show three lines of text on the Waveshare Pico-LCD-1.8.
#
# Wire the LCD to the Pico directly, or plug both into a Pico Dual Expander to
# leave the debug USB free. Either way, the pins below are what the Waveshare
# board connects to; no soldering, no jumpers.
#
# Good place for a breakpoint: line 63, panel.fill(BACKGROUND). Set it, press
# F5, then F10 to step over -- the screen changes colour while the debugger is
# stopped, which is the quickest proof that F5 drives the real board.

from machine import Pin, SPI
import st7735

# Waveshare Pico-LCD-1.8 pinout.
LCD_SCK = 10
LCD_MOSI = 11
LCD_CS = 9
LCD_DC = 8
LCD_RST = 12
LCD_BL = 13

# RGB565 colours. Change these if you want a different look.
BACKGROUND = 0xF800           # red
TEXT = 0xFFFF                 # white
TITLE = 0xFFE0                # yellow, for the top line

# ST7735 chips have a 132x162 GRAM but the visible panel is only 128x160.
# Different Waveshare / greentab / redtab / blacktab units place the visible
# window at slightly different origins within GRAM, so if you see a strip of
# stray pixels at one or more edges, walk these until the strip disappears.
# Common values are (0, 0), (1, 2), (2, 1), (2, 3).
COL_OFFSET = 1
ROW_OFFSET = 2

# What to show. The built-in 8x8 font fits 20 characters across a 160-pixel
# landscape screen, so the two longer sentences below wrap onto two rows.
LINES = [
    ("MicroPython Debugger", TITLE),
    ("",                     0),        # blank row for visual gap
    ("Real debug, only",     TEXT),
    ("hit F5",               TEXT),
    ("",                     0),
    ("www.ghielectronics",   TEXT),
    (".com",                 TEXT),
]


def build_display():
    spi = SPI(1, baudrate=20_000_000, polarity=0, phase=0,
              sck=Pin(LCD_SCK), mosi=Pin(LCD_MOSI))
    panel = st7735.ST7735(spi, cs=LCD_CS, dc=LCD_DC, rst=LCD_RST, bl=LCD_BL,
                          width=128, height=160, rotation=3,
                          col_offset=COL_OFFSET, row_offset=ROW_OFFSET)
    panel.init()
    return panel


def draw(panel):
    # Clear to black first, then paint the real background. Some ST7735 units
    # power up with random garbage in RAM that flashes when the backlight comes
    # on; the black wipe hides it before the coloured fill lands.
    panel.fill(0x0000)
    panel.fill(BACKGROUND)

    line_height = 10                    # 8 px font + 2 px gap
    block = len(LINES) * line_height
    y = (panel.height - block) // 2

    for text, colour in LINES:
        if text:
            x = (panel.width - panel.text_width(text)) // 2
            panel.text(text, x, y, colour, BACKGROUND)
        y += line_height


panel = build_display()
draw(panel)
print("shown")
