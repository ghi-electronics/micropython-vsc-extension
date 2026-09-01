# Uncaught-exception sample.
#
# Press F5 with no breakpoints set. The loop counts down, and when count
# reaches 0 the division raises ZeroDivisionError with nothing to catch it.
#
# What to expect:
#   - the debugger halts at line 19, inside divide(), where the raise happened
#   - the Call Stack shows  divide()  <-  compute()  <-  (module)
#   - the Debug Console shows the exception text
#   - Globals still work, so you can inspect state at the point of the crash
#
# Without this, an uncaught exception would simply end the program and VS Code
# would show nothing.

import time


def divide(a, b):
    return a / b


def compute(n):
    total = divide(100, n)
    return total


count = 3
while True:
    print("computing with", count)
    print("result", compute(count))
    count = count - 1
    time.sleep_ms(400)
