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

Local variables are not shown. Upstream MicroPython does not record local
*names* in its bytecode, and adding them would break compatibility with stock
`.mpy` files and the standard library ecosystem. Globals and Watch expressions
cover module-level state.

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
