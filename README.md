# MicroPython for SITCore

Source-level MicroPython debugging over USB for GHI Electronics SITCore devices,
driven from VS Code with F5.

This is standalone MicroPython firmware and tooling for SITCore hardware, for
users who would rather not use TinyCLR. A board runs MicroPython **or** TinyCLR,
never both.

## What works

Breakpoints, step over / in / out, pause, a full call stack, global variables
with expandable lists, dicts and objects, Watch and hover evaluation, `print()`
in the Debug Console, and workspace deployment -- all over a single USB cable,
on a second CDC interface so the REPL stays usable on the first.

Local variables are shown, and they are never guessed at. MicroPython stores
argument names in the bytecode, so the device reports those exactly -- inside a
`.mpy` too. The remaining locals are worked out from your source, and that
analysis is checked against the argument names the device knows for certain
before any of it is used. If the two disagree, only the arguments are named
rather than risking a value labelled with the wrong name.

None of this changes the bytecode format, so stock `.mpy` files and the whole
MicroPython library ecosystem keep working.

## Using libraries

Anything in `lib/` is on the device's `sys.path`, so a third-party module dropped
there is imported by its own name -- `import mathutil`, not `from lib import
mathutil`.

Both `.py` and `.mpy` are deployed, and **breakpoints work inside a `.mpy`**: the
compiled form keeps its line table and the name of the source it was built from.
Precompiling is worth it on a 111 KB filesystem.

One thing to get right when precompiling: `mpy-cross` stores the path exactly as
you type it, and that stored path is what breakpoints match against. Compile with
a **relative** path from the project directory:

```
mpy-cross -o lib/greet.mpy lib/greet.py      # good: stores "lib/greet.py"
mpy-cross -o lib/greet.mpy C:/proj/lib/greet.py   # stores the absolute path
```

Either still works -- the extension falls back to matching by name -- but the
relative form is what makes the frame open the right file first time.

Avoid shipping `foo.py` and `foo.mpy` together. MicroPython imports the `.mpy`,
so an out-of-date one silently wins and breakpoints land at the line numbers it
was compiled with. The extension warns when it sees both.

Data files are not deployed unless you ask, since the filesystem is small. List
them in `launch.json`:

```json
"include": ["data/*.json", "**/*.csv"]
```

`mip` cannot install packages on the device -- there is no network on SC13xxx.
Download them on the PC and put them in `lib/`.

## How it fits together

| Layer | Where |
|---|---|
| VS Code extension + debug adapter | this repository |
| Debug engine (C) | `ports/stm32/mpdebug/` in the firmware fork |

The debug adapter runs in-process, so there is no separate server to install and
no .NET or Python dependency.

## Requirements

- A SITCore device running the MicroPython firmware from the companion fork,
  with the MODE pin high so it enumerates as two CDC interfaces
- VS Code 1.85 or newer

Windows, Linux and macOS are all supported. The extension's one native
dependency ships prebuilt for every platform inside the `.vsix`, so there is
nothing to compile and no toolchain to install.

### Windows

Nothing to set up. Windows 10 and later install the USB serial driver
automatically.

### Linux

Install the udev rule once, then replug the board:

```
sudo cp udev/99-sitcore-micropython.rules /etc/udev/rules.d/
sudo udevadm control --reload-rules && sudo udevadm trigger
```

This does two things, and skipping it causes symptoms that look like extension
bugs. It grants your user access to the port -- otherwise opening it fails with
"permission denied", because `/dev/ttyACM*` belongs to the `dialout` group. And
it stops ModemManager probing the debug channel with AT commands for the first
several seconds after every plug-in.

Without the rule, the fallback for permissions alone is
`sudo usermod -a -G dialout $USER`, followed by logging out and back in.

### macOS

Nothing to set up; the CDC driver is part of the OS.

## Building

Windows is the build host:

```
build-extension.bat            compile to the out directory
build-extension.bat package    compile, then produce an installable .vsix
```

One `.vsix` built on Windows installs on Windows, Linux and macOS.

Or directly:

```
npm install
npm run compile
node test/link_test.js     # drives a real board, no VS Code needed
```

Press F5 in VS Code to launch an Extension Development Host.
