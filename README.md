# MicroPython for SITCore

**Real source-level debugging for MicroPython, on real hardware, over one USB cable.**

Set a breakpoint in the gutter. Press F5. Your code deploys, the board restarts, and
execution stops on that line — with the call stack, your variables, and a working
Watch window. No JTAG, no debug probe, no wiring.

Proper debugging has always come with SITCore: run TinyCLR and you write C# and debug
it in Visual Studio. This puts MicroPython on the same footing — breakpoints, stepping,
call stack and variables, in VS Code, on the same board and the same cable.

Pick the language that suits the job. A board runs MicroPython **or** TinyCLR, never
both.

## What you get

| | |
|---|---|
| **Breakpoints** | Conditional, with hit counts. Anywhere, including inside imported modules. |
| **Stepping** | Step over, into, out of. Pause a running program. |
| **Call stack** | Every frame, with file and line, click to open. |
| **Variables** | Locals *and* globals. Expand lists, dicts and objects, nested. |
| **Watch & hover** | Evaluate any expression in the stopped frame. Hover a name to see its value. |
| **Edit a value** | Change a global while stopped and carry on running. |
| **`print()` output** | Straight into the Debug Console. |
| **Exceptions** | Stops at the line that raised, not after the stack is gone. |
| **Deploy on F5** | Only the files that changed, by CRC. Removes files you deleted locally. |
| **Live REPL** | A terminal on the board — usable *while stopped at a breakpoint*. |

## Getting started

1. Flash the SITCore MicroPython firmware.
2. Open a folder containing a `.py` file.
3. Press **F5**, and pick *MicroPython (SITCore, USB)*.

That is the whole setup — no `launch.json`, no project file, no Python environment. The
extension offers to save a launch configuration afterwards so F5 stops asking.

Starting from an empty folder? **MicroPython: New Project** writes a sample `main.py`, a
`lib/` directory and a launch configuration.

## Commands

| Command | What it does |
|---|---|
| MicroPython: Open Device Shell (REPL) | A terminal on the board, usable while debugging |
| MicroPython: Device Info | Firmware protocol version, limits, filesystem usage |
| MicroPython: Erase Deployed Files | Removes deployed `.py` and `.mpy`, keeps `boot.py` |
| MicroPython: New Project | Scaffolds an empty folder |
| MicroPython: Select Device | Choose the port when more than one board is attached |

**Ctrl+F5** runs without debugging: deploys and runs, `print()` still reaches the Debug
Console, no breakpoints.

## Using libraries

Both `.py` and `.mpy` files are deployed, and **breakpoints work inside a `.mpy`**.

If a `.py` and a `.mpy` exist for the same module, MicroPython imports the `.mpy`, so an
out-of-date one puts breakpoints at the lines it was compiled with. The extension warns
when it sees both.

Data files are deployed only if you list them, since the filesystem is small:

```json
"include": ["data/*.json", "**/*.csv"]
```

## Known limits

- **Non-argument locals need your source.** A module deployed as `.mpy` with no `.py`
  beside it shows its arguments, not its other locals.
- **Caught exceptions do not stop.** Only an exception that would reach the top level
  halts execution; a `try` that would handle it suppresses the stop.
- **`@micropython.native` and `@micropython.viper` cannot be debugged.** They emit no
  trace events, so breakpoints inside them never fire. The code still runs correctly.
- **Single-threaded.** `_thread` is not enabled on SC13xxx.
- **First deploy of a large project takes a few seconds.** After that only changed files
  are sent, so an edit-and-run cycle is a fraction of a second.

## Requirements

- A SITCore device running the MicroPython firmware from the companion fork
- VS Code 1.85 or newer

Windows, Linux and macOS are all supported. The one native dependency ships prebuilt for
every platform inside the `.vsix`, so there is nothing to compile and no toolchain to
install.

### Windows

Nothing to set up. Windows 10 and later install the USB serial driver automatically.

### Linux

Install the udev rule once, then replug the board:

```
sudo cp udev/99-sitcore-micropython.rules /etc/udev/rules.d/
sudo udevadm control --reload-rules && sudo udevadm trigger
```

This does two things, and skipping it causes symptoms that look like extension bugs. It
grants your user access to the port — otherwise opening it fails with "permission
denied", because `/dev/ttyACM*` belongs to the `dialout` group. And it stops ModemManager
probing the debug channel with AT commands for several seconds after every plug-in.

Without the rule, the fallback for permissions alone is `sudo usermod -a -G dialout
$USER`, then log out and back in.

### macOS

Nothing to set up; the CDC driver is part of the OS.

## How it fits together

| Layer | Where |
|---|---|
| VS Code extension + debug adapter | this repository |
| Debug engine (C) | `ports/stm32/mpdebug/` in the firmware fork |

The debug adapter runs in-process, so there is no separate server to install and no .NET
or Python dependency.

## Building

Windows is the build host:

```
build-extension.bat            compile to the out directory
build-extension.bat package    compile, then produce an installable .vsix
```

The package is named for the version in `package.json`, so a `.vsix` on disk says which
build it is: `micropython-sitcore-debug_v0.1.0.vsix`.

One `.vsix` built on Windows installs on Windows, Linux and macOS.

Or directly:

```
npm install
npm run compile
node test/findports_test.js    # no hardware needed
node test/link_test.js         # drives a real board, no VS Code needed
```

Press F5 in VS Code to launch an Extension Development Host.
