# Copyright (c) GHI Electronics.
# SPDX-License-Identifier: MIT
#
# SITCore SC13048 -- Snake
#
# The classic snake game on a 128x160 ST7735 TFT.  Grow the snake by eating
# the red food; do not run into the walls or your own body.  Runs in about
# 300 lines of MicroPython, including a short ST7735 helper.
#
# Wiring:
#   ST7735 1.8" TFT       SC13048 pin
#   -------------------   ---------------
#   VCC                   3V3
#   GND                   GND
#   SCK                   PB3   (SPI1 SCK -- MicroPython's SPI(1) default)
#   SDA (MOSI)            PB5   (SPI1 MOSI)
#   CS                    PB14
#   DC / RS               PA14
#   RES / RST             PA13
#   BL / LED              PB13
#
#   Buzzer                PA5   (PWM, add a series resistor for a passive one)
#   On-board LED          PA8   (blinks when food is eaten)
#
#   Buttons -- active LOW, external pull-ups on the board.
#   Physical layout on the SC13048 board:
#     PC13 (LDR button)   left button   -> turn LEFT
#     PB7                 centre button -> pause / start / restart
#     PA15                right button  -> turn RIGHT
#
# A great place for a breakpoint: the `(nx, ny) in snake[1:]` self-collision
# check inside play().  Watch `snake` grow one segment at a time as you eat.

from machine import Pin, SPI, PWM
import random
import time
import st7735


# ---------------------------------------------------------------- hardware

spi = SPI(1, baudrate=10_000_000, polarity=0, phase=0)
# rotation=3 puts the display in landscape (160 wide, 128 tall) with the
# ribbon cable / origin on the opposite side from rotation=1 -- flip this
# to 1 if your panel comes out upside-down for your mounting.
lcd = st7735.ST7735(spi, cs='B14', dc='A14', rst='A13', bl='B13', rotation=3)
lcd.init()

buzzer = PWM(Pin('A5'), freq=1000, duty_u16=0)
led = Pin('A8', Pin.OUT, value=0)

# Physical order left / centre / right on the SC13048 board.  If you build
# your own hardware and swap the buttons, this is the only block to touch.
btn_left = Pin('C13', Pin.IN, Pin.PULL_UP)
btn_centre = Pin('B7', Pin.IN, Pin.PULL_UP)
btn_right = Pin('A15', Pin.IN, Pin.PULL_UP)


def beep(freq, ms):
    """Short buzzer chirp -- freq in Hz, duration in ms.  freq=0 silences."""
    if freq:
        buzzer.freq(freq)
        buzzer.duty_u16(32768)
    time.sleep_ms(ms)
    buzzer.duty_u16(0)


# ------------------------------------------------------ colours (RGB565)

BLACK = 0x0000
WHITE = 0xFFFF
GREEN = 0x0500     # snake body
LIME = 0x87E0     # snake head, brighter for visibility
RED = 0xF800      # food
BLUE = 0x001F     # status bar


# ------------------------------------------------------ screen geometry

W = lcd.width               # 128
H = lcd.height              # 160
CELL = 8
GRID_W = W // CELL          # 16 columns
STATUS_H = 16               # top bar for the score
GRID_H = (H - STATUS_H) // CELL   # 18 rows


# ------------------------------------------------------ tiny fill helper
#
# The stock st7735 module has fill() and text() but not fill_rect(); the
# game draws mostly 8x8 cells so this is really "draw one cell" for the
# common path.  Kept generic in case you extend it.

def fill_rect(x, y, w, h, colour):
    if w <= 0 or h <= 0:
        return
    lcd.set_window(x, y, x + w - 1, y + h - 1)
    row = bytearray(w * 2)
    hi, lo = colour >> 8, colour & 0xFF
    for i in range(0, len(row), 2):
        row[i] = hi
        row[i + 1] = lo
    lcd.cs.value(0)
    lcd.dc.value(1)
    for _ in range(h):
        lcd.spi.write(row)
    lcd.cs.value(1)


def draw_cell(gx, gy, colour):
    fill_rect(gx * CELL, STATUS_H + gy * CELL, CELL, CELL, colour)


def erase_cell(gx, gy):
    draw_cell(gx, gy, BLACK)


# ------------------------------------------------------ buttons

def read_press(pin, state):
    """Detect a fresh press (rising-edge of "held").

    state is a dict shared with subsequent calls; the caller keeps it
    across ticks so a held button does not fire twice.
    """
    down = not pin.value()      # active LOW
    fresh = down and not state['held']
    state['held'] = down
    return fresh


def wait_press(pin):
    """Block until this button has been pressed and released.  Debounced."""
    while not pin.value():
        time.sleep_ms(10)       # wait for prior release
    while pin.value():
        time.sleep_ms(10)       # wait for the press
    time.sleep_ms(30)           # debounce


# ------------------------------------------------------ game logic

# Directions cycle E -> S -> W -> N when turning right, and the other way
# when turning left.  (dx, dy) in screen coordinates.
DIRS = ((1, 0), (0, 1), (-1, 0), (0, -1))


def random_food(snake):
    """Random empty cell for the food.  Small board, brute-force is fine."""
    while True:
        p = (random.randint(0, GRID_W - 1), random.randint(0, GRID_H - 1))
        if p not in snake:
            return p


def draw_score(score):
    fill_rect(0, 0, W, STATUS_H, BLUE)
    lcd.text('SCORE {}'.format(score), 4, 4, WHITE, BLUE)


def play():
    """One round.  Returns the final score when the snake dies."""
    lcd.fill(BLACK)
    draw_score(0)

    # Snake starts as three cells in the middle, heading east.
    cx, cy = GRID_W // 2, GRID_H // 2
    snake = [(cx - 2, cy), (cx - 1, cy), (cx, cy)]
    for x, y in snake:
        draw_cell(x, y, GREEN)
    draw_cell(snake[-1][0], snake[-1][1], LIME)

    direction = 0                       # 0=E, 1=S, 2=W, 3=N
    food = random_food(snake)
    draw_cell(food[0], food[1], RED)

    score = 0
    tick_ms = 180                       # slower at first; speeds up as you eat

    left_state = {'held': not btn_left.value()}
    right_state = {'held': not btn_right.value()}
    action_state = {'held': not btn_centre.value()}

    while True:
        # Poll buttons frequently across the tick so a fast tap is not missed,
        # but only allow one turn per tick to keep the snake from doubling
        # back onto itself in one move.
        deadline = time.ticks_add(time.ticks_ms(), tick_ms)
        turned_this_tick = False
        while time.ticks_diff(deadline, time.ticks_ms()) > 0:
            if not turned_this_tick:
                if read_press(btn_left, left_state):
                    direction = (direction - 1) % 4
                    turned_this_tick = True
                elif read_press(btn_right, right_state):
                    direction = (direction + 1) % 4
                    turned_this_tick = True
            if read_press(btn_centre, action_state):
                # Pause: block until the action button is pressed again.
                while not read_press(btn_centre, action_state):
                    time.sleep_ms(20)
                # Reset the deadline so the pause does not count as game time.
                deadline = time.ticks_add(time.ticks_ms(), tick_ms)
            time.sleep_ms(5)

        # Compute next head position.
        dx, dy = DIRS[direction]
        head = snake[-1]
        nx, ny = head[0] + dx, head[1] + dy

        # Wall collision.
        if nx < 0 or nx >= GRID_W or ny < 0 or ny >= GRID_H:
            beep(200, 250)
            return score

        # Self collision.  Skip the tail cell because it is about to move.
        if (nx, ny) in snake[1:]:
            beep(200, 250)
            return score

        # Draw the new head and dim the old head to body colour.
        snake.append((nx, ny))
        draw_cell(nx, ny, LIME)
        draw_cell(head[0], head[1], GREEN)

        if (nx, ny) == food:
            # Ate food: grow (do not drop the tail), respawn food, speed up.
            score += 1
            draw_score(score)
            beep(1200, 30)
            led.on()
            food = random_food(snake)
            draw_cell(food[0], food[1], RED)
            if tick_ms > 60:
                tick_ms -= 4
        else:
            # Ordinary move: drop the tail.
            tail = snake.pop(0)
            erase_cell(tail[0], tail[1])
            led.off()


# ------------------------------------------------------ screens

def draw_start_screen():
    lcd.fill(BLACK)
    # "SNAKE" title -- 5 chars * 8 * scale2 = 80 px, centred in 160-wide.
    lcd.text('SNAKE', 40, 16, LIME, BLACK, scale=2)
    lcd.text('LDR : left', 40, 50, WHITE, BLACK)
    lcd.text('PB7 : play', 40, 64, WHITE, BLACK)
    lcd.text('PA15: right', 36, 78, WHITE, BLACK)
    lcd.text('Press PB7', 44, 104, WHITE, BLACK)


def draw_game_over(score):
    lcd.fill(BLACK)
    # "GAME OVER" is 9 chars * 16 = 144 px, near the full 160 width.
    lcd.text('GAME OVER', 8, 22, RED, BLACK, scale=2)
    lcd.text('Score {}'.format(score), 44, 68, WHITE, BLACK)
    lcd.text('Press PB7', 44, 98, WHITE, BLACK)
    lcd.text('to retry', 48, 112, WHITE, BLACK)


# ------------------------------------------------------ main

draw_start_screen()
while True:
    wait_press(btn_centre)
    score = play()
    draw_game_over(score)
    wait_press(btn_centre)
