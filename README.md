# MicroPython for SITCore

Source-level MicroPython debugging over USB for GHI Electronics SITCore devices,
driven from VS Code with F5.

This is standalone MicroPython firmware and tooling for SITCore hardware, for
users who would rather not use TinyCLR. A board runs MicroPython **or** TinyCLR,
never both.

## What works

Breakpoints, step over / in / out, pause, a full call stack, and workspace
deployment -- all over a single USB cable, on a second CDC interface so the REPL
stays usable on the first.

Variables are not implemented yet; VS Code shows an empty scope list.

## How it fits together

| Layer | Where |
|---|---|
| VS Code extension + debug adapter | this repository |
| Debug engine (C) | `ports/stm32/mpdebug/` in the firmware fork |

The debug adapter runs in-process, so there is no separate server to install and
no .NET or Python dependency.

## Requirements

- A SITCore device running the MicroPython firmware from the companion fork,
  configured for two CDC interfaces (`pyb.usb_mode('VCP+VCP')`)
- VS Code 1.85 or newer

## Development

```
npm install
npm run compile
node test/link_test.js     # drives a real board, no VS Code needed
```

Press F5 in VS Code to launch an Extension Development Host.
