# SITCore SC13048 -- Snake

The classic snake game on a 128x160 ST7735 TFT, run in landscape mode
(160 wide by 128 tall).  Grow the snake by eating the red food; do not
run into the walls or your own body.

## Wiring

| Component | SC13048 pin |
|---|---|
| **ST7735 1.8" TFT** VCC | 3V3 |
|                     GND | GND |
|                     SCK | PB3 (SPI1 SCK) |
|                     SDA (MOSI) | PB5 (SPI1 MOSI) |
|                     CS  | PB14 |
|                     DC / RS | PA14 |
|                     RES / RST | PA13 |
|                     BL / LED | PB13 |
| **Buzzer** (passive, add a series resistor) | PA5 |
| **On-board green LED** (blinks on eat) | PA8 |

Three buttons, in **physical left / centre / right** order as they sit
on the SC13048 board:

| Button position | SC13048 pin | In-game action |
|---|---|---|
| Left    | PC13 (on-board LDR button) | turn LEFT  |
| Centre  | PB7                        | pause / start / restart |
| Right   | PA15                       | turn RIGHT |

Buttons connect to GND when pressed.  The SC13048 has external pull-ups
on these lines, so nothing else is needed.

## Play

1. Press **F5** in VS Code (MicroPython Debugger) to deploy the project.
2. On the title screen, press the **centre** button (PB7) to start.
3. Turn the snake **left** with the left button (PC13) and **right**
   with the right button (PA15).  Turns are relative to the snake's
   current heading -- so if it is going east, "left" turns it north.
4. Eat the red squares to grow.  The snake speeds up gently after every
   food.
5. Press the centre button at any time to pause; press again to resume.
6. Hit a wall or your own tail and the game ends.  Press the centre
   button to retry.

## Debug it

Snake state is short enough to eyeball in the Variables pane:

- `snake` is a list of `(x, y)` grid cells.  The last element is the head.
- `food` is a single `(x, y)` tuple.
- `direction` is 0 = East, 1 = South, 2 = West, 3 = North.

Good places for a breakpoint:

- The `(nx, ny) in snake[1:]` line -- watch what "just barely missed the
  tail" looks like from the debugger.
- Inside the `if (nx, ny) == food:` block -- the moment before the snake
  grows, `snake` is one shorter than after.

Because the game loop sleeps in short chunks (`time.sleep_ms(5)`), you
can single-step (F10) through moves cleanly without the display or the
buttons losing state.
