# pico-lcd18

Shows three lines of text on the [Waveshare Pico-LCD-1.8](https://www.waveshare.com/wiki/Pico-LCD-1.8),
plugged into a Raspberry Pi Pico or Pico 2. Press **F5**.

```
MicroPython Debugger
Real debug, only
     hit F5
www.ghielectronics
       .com
```

## Wiring

The LCD is a solder-free header shield. Push it onto the Pico's pins (or into
a Pico Dual Expander alongside your debug USB) and you are wired.

| LCD signal | Pico GPIO |
|---|---|
| CS | 9 |
| SCK | 10 |
| MOSI | 11 |
| DC | 8 |
| RST | 12 |
| BL | 13 |

## Debugging it

`main.py` line 63 is `panel.fill(BACKGROUND)`. Set a breakpoint there, press
F5, then **F10** to step over — the screen changes colour while the debugger
is stopped, which is the quickest proof that F5 drives the real board.

Hover any of the colour constants (BACKGROUND, TEXT, TITLE) to see the RGB565
hex; edit them in `main.py` for a different look.

## Notes

- The built-in 8×8 font fits 20 characters across the 160-pixel landscape
  screen, so the two longer sentences wrap onto two rows. Edit `LINES` in
  `main.py` to change the text.
- If the display shows garbage stripes at one edge, your unit has a slightly
  different bezel — set `col_offset` or `row_offset` at the top of
  `st7735.py`. Common values are 2 or 3.
