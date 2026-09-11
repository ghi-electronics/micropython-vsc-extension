# XIAO ESP32-S3 -- SG90 Servo Sweep

Drives an SG90 mini 9g servo on **pin D10** of the Seeed XIAO ESP32-S3.
D10 sits three pins away from 5V and GND on the same edge of the board, so
the three servo wires run in a neat little bundle instead of crossing the
board.

## Wiring

| Servo wire            | XIAO pin        |
|-----------------------|-----------------|
| Brown (or black)      | GND             |
| Red                   | 5V              |
| Orange (or yellow)    | D10 (GPIO 9)    |

Power the board over USB. The XIAO's 5V pin passes USB voltage straight
through, which the SG90 is happy with while unloaded. If the servo has to
push something heavier than the plastic horn, give it its own supply and
share GND with the XIAO.

## Run

Press **F5**. The horn should step 0 -> 45 -> 90 -> 135 -> 180 and back,
about 400 ms per step.

## Debugging it

`main.py` line 42 is `set_angle(angle)` inside the `for` loop. Put a
breakpoint there and press F5 repeatedly:

- the debugger stops **before** each write, so the horn holds its previous
  position
- `angle` in the Locals pane shows what the next duty will be
- F5 lets the write out and the servo jumps

That is one of the more satisfying demonstrations that F5 is driving the
board, not running the script on the PC.

## Servo not moving?

- **Buzzing but no motion.** The pulse range does not match this
  particular servo. Widen or narrow `MIN_US` / `MAX_US` at the top of
  `main.py`.
- **Board browning out / rebooting.** The servo is stalled or loaded
  beyond what USB can supply. Give it a separate 5V source and share GND.
- **Nothing at all.** Check the orange wire is on D10 (GPIO 9), not D9 or
  D11 -- they neighbour each other on the same edge.
