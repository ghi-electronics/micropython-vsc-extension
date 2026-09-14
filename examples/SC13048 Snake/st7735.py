# ST7735 driver for the Waveshare Pico-LCD-1.8 (160x128 landscape, 128x160 portrait).
#
# Standard 4-wire SPI -- CS, SCK, MOSI, D/C, RST -- which is what MicroPython's
# machine.SPI drives out of the box. No QSPI tricks, no vendor init secrets.
#
# The init sequence and offsets below are the well-known "greentab" values that
# match Waveshare's 128x160 modules. If your unit shows garbage stripes at one
# edge, adjust COL_OFFSET / ROW_OFFSET at the top of ST7735 -- the panel is
# fine, it just has an unusual bezel.

import time
import framebuf
from machine import Pin


class ST7735:
    """A 128x160 ST7735 panel driven over standard 4-wire SPI."""

    def __init__(self, spi, cs, dc, rst, bl=None,
                 width=128, height=160, rotation=0,
                 col_offset=0, row_offset=0):
        self.spi = spi
        self.cs = Pin(cs, Pin.OUT, value=1)
        self.dc = Pin(dc, Pin.OUT, value=0)
        self.rst = Pin(rst, Pin.OUT, value=1)
        self.bl = Pin(bl, Pin.OUT, value=0) if bl is not None else None
        self.rotation = rotation & 3
        # Rotation 1 and 3 turn the panel on its side. Do the swap once here so
        # everything upstairs stays in screen coordinates.
        if self.rotation & 1:
            self.width, self.height = height, width
        else:
            self.width, self.height = width, height
        self.col_offset = col_offset
        self.row_offset = row_offset

    # -- transactions ------------------------------------------------------

    def _cmd(self, byte):
        self.cs.value(0)
        self.dc.value(0)
        self.spi.write(bytes([byte]))
        self.cs.value(1)

    def _data(self, data):
        self.cs.value(0)
        self.dc.value(1)
        self.spi.write(data)
        self.cs.value(1)

    def _write(self, cmd, data=None):
        self._cmd(cmd)
        if data:
            self._data(data)

    # -- setup -------------------------------------------------------------

    def reset(self):
        self.rst.value(1)
        time.sleep_ms(10)
        self.rst.value(0)
        time.sleep_ms(50)
        self.rst.value(1)
        time.sleep_ms(150)

    def init(self):
        """Bring the panel out of reset and into a state that shows pixels."""
        self.reset()
        self._write(0x01)                              # SWRESET
        time.sleep_ms(150)
        self._write(0x11)                              # SLPOUT
        time.sleep_ms(500)

        # Frame rate control -- normal / idle / partial modes. Values from the
        # Adafruit ST7735 reference driver; they match every 128x160 board.
        self._write(0xB1, bytes([0x01, 0x2C, 0x2D]))
        self._write(0xB2, bytes([0x01, 0x2C, 0x2D]))
        self._write(0xB3, bytes([0x01, 0x2C, 0x2D, 0x01, 0x2C, 0x2D]))
        self._write(0xB4, bytes([0x07]))               # inversion control

        # Power control.
        self._write(0xC0, bytes([0xA2, 0x02, 0x84]))
        self._write(0xC1, bytes([0xC5]))
        self._write(0xC2, bytes([0x0A, 0x00]))
        self._write(0xC3, bytes([0x8A, 0x2A]))
        self._write(0xC4, bytes([0x8A, 0xEE]))
        self._write(0xC5, bytes([0x0E]))               # VMCTR1

        self._write(0x20)                              # INVOFF

        self._write(0x36, bytes([self._madctl()]))     # orientation + BGR
        self._write(0x3A, bytes([0x05]))               # 16bpp RGB565

        # Gamma. Cosmetic, but the panel looks washed out without it.
        self._write(0xE0, bytes([
            0x02, 0x1C, 0x07, 0x12, 0x37, 0x32, 0x29, 0x2D,
            0x29, 0x25, 0x2B, 0x39, 0x00, 0x01, 0x03, 0x10]))
        self._write(0xE1, bytes([
            0x03, 0x1D, 0x07, 0x06, 0x2E, 0x2C, 0x29, 0x2D,
            0x2E, 0x2E, 0x37, 0x3F, 0x00, 0x00, 0x02, 0x10]))

        self._write(0x13)                              # normal display
        self._write(0x29)                              # DISPON
        time.sleep_ms(100)

        if self.bl:
            self.bl.value(1)

    def _madctl(self):
        # MADCTL: MY MX MV | reserved | BGR | reserved
        # Waveshare's 1.8 uses BGR order (0x08).
        return (
            0x00 | 0x08,                # 0: portrait
            0x60 | 0x08,                # 1: landscape (MV|MX)
            0xC0 | 0x08,                # 2: portrait flipped
            0xA0 | 0x08,                # 3: landscape flipped
        )[self.rotation]

    # -- drawing -----------------------------------------------------------

    def set_window(self, x0, y0, x1, y1):
        """Where the next pixels land. Coordinates are inclusive."""
        x0 += self.col_offset
        x1 += self.col_offset
        y0 += self.row_offset
        y1 += self.row_offset
        self._write(0x2A, bytes([x0 >> 8, x0 & 0xFF, x1 >> 8, x1 & 0xFF]))
        self._write(0x2B, bytes([y0 >> 8, y0 & 0xFF, y1 >> 8, y1 & 0xFF]))
        self._cmd(0x2C)                                # RAMWR

    def fill(self, colour):
        """Flood the screen with one RGB565 colour."""
        self.set_window(0, 0, self.width - 1, self.height - 1)
        row = bytearray(self.width * 2)
        hi, lo = colour >> 8, colour & 0xFF
        for i in range(0, len(row), 2):
            row[i] = hi
            row[i + 1] = lo
        self.cs.value(0)
        self.dc.value(1)
        for _ in range(self.height):
            self.spi.write(row)
        self.cs.value(1)

    def text_width(self, s, scale=1):
        """Pixels a string will occupy. The built-in font is 8x8, fixed."""
        return 8 * len(s) * scale

    def text(self, string, x, y, colour=0xFFFF, background=0x0000, scale=1):
        """Draw one line using MicroPython's built-in 8x8 font.

        Glyphs come from framebuf but pixels are emitted directly -- framebuf's
        RGB565 buffer stores in little-endian byte order and the panel expects
        big-endian, so a naive framebuf.RGB565 pipeline produces the wrong
        colours across the board.
        """
        w = 8 * len(string)
        stride = (w + 7) // 8
        glyphs = bytearray(stride * 8)
        framebuf.FrameBuffer(glyphs, w, 8, framebuf.MONO_HLSB).text(
            string, 0, 0, 1)

        fg = (colour >> 8, colour & 0xFF)
        bg = (background >> 8, background & 0xFF)
        row = bytearray(w * scale * 2)

        self.set_window(x, y, x + w * scale - 1, y + 8 * scale - 1)
        self.cs.value(0)
        self.dc.value(1)
        for sy in range(8):
            i = 0
            base = sy * stride
            for sx in range(w):
                on = glyphs[base + (sx >> 3)] & (0x80 >> (sx & 7))
                hi, lo = fg if on else bg
                for _ in range(scale):
                    row[i] = hi
                    row[i + 1] = lo
                    i += 2
            for _ in range(scale):
                self.spi.write(row)
        self.cs.value(1)
