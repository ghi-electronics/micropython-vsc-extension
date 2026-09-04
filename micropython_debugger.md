# MicroPython USB Debugger — working reference

Project started 2026-08-31. Goal: source-level MicroPython debugging (breakpoints, step,
stack, variables) over **USB**, driven from VS Code with F5.

**SC13xxx (STM32L4) is done and verified on hardware.** The next phase is other boards --
**Pico 2 (RP2350) first**, then ESP32, with SITCore staying first-class. Section 12 has that
plan; section 11 has what already works.

Working root: `C:\Projects\2026\MicroPython\`

**What this project is.** MicroPython firmware with a source-level debugger built into it,
plus the VS Code extension that drives it. On SITCore a board runs MicroPython **or** TinyCLR,
never both; there is no dual-mode or interop story.

**How TinyCLR relates to it.** Only as a source of working code and hard-won design. The wire
protocol, the debug-engine shape and the host-side C# stack are reused rather than re-derived --
they are GHI's own code and they already work. That reuse is an engineering shortcut, not a
coupling: nothing here needs TinyCLR present, installed, or running.

**How to resume:** load this file, say "continue". Everything below is the result of a full
research session — prior art, reuse map, hardware facts, architecture decisions and traps.
Do not re-research it. **Section 11 = what works today (SC13xxx). Section 12 = the port
plan and what was learned about the competing extension.**

---

## 0. Repository layout

| Path | Role |
|---|---|
| `C:\Projects\2026\MicroPython\DebuggerExtension` | VS Code extension + host-side DAP server |
| `C:\Projects\2026\MicroPython\Firmware\micropython` | MicroPython fork. `origin` = `ghi-electronics/micropython`, branch **`sitcore-debugger`** off tag **`v1.29.0`** |
| `C:\Projects\2026\MicroPython\micropython_debugger.md` | this file |

**Reference-only roots (READ, never edit):**

| Path | Why |
|---|---|
| `C:\Projects\2026\TinyCLROS\TinyCLR-Core` | device-side debug engine + WireProtocol — the blueprint |
| `C:\Projects\2026\TinyCLROS\TinyCLR-SDK\GHIElectronics.TinyCLR.Debugger` | host-side Engine, WireProtocol, WinUSB transport |
| `C:\Projects\2026\TinyCLROS\TinyCLR-VSCode` | VS Code extension + DapServer (the F5 flow) |
| `C:\Projects\2026\TinyCLROS\TinyCLR-Devices\Devices\Sc13xxx` | SC13xxx hardware definition |
| `C:\Projects\2026\TinyCLROS\TinyCLR-Devices\Targets\STM32L4xx` | L4 peripheral drivers (USB, QSPI, clocks) |

TinyCLR OS has its own reference doc: `C:\Projects\2026\TinyCLROS\TinyCLR_OS_v3.0.1.6000.md`.
Its rules about MMP, dual-mode, NuGet and VSIX are **not** relevant here. Its firmware/hardware
traps and working conventions **are** — see section 9.

---

## 1. Locked decisions

Decided deliberately. Do not relitigate without new information.

1. ~~**SC13xxx only, for now.**~~ ~~**SUPERSEDED 2026-09-02.**~~ **REVISED 2026-09-03.**
   SC13xxx was the proof that this is doable at all, and it served that purpose. It is **not**
   the first-class target. The targets that matter are **ESP32, RP2040 / RP2350, and SC20xxx
   (STM32H743)**, and on every one of them the bar is the same: **hit F5 and debug, exactly as
   on SC13xxx.** No setup steps, no "run this first", no capabilities the user has to give up
   — notably not threads. Anything that would become a rule the user has to follow is a defect
   in the debugger, not a documented limitation. (User decision, 2026-09-03; this is decision 7
   applied to the roadmap.) First board for RP2: **Pico 2 (RP2350)** — hardware is on the desk.
2. **Three-tier architecture** (the shape TinyCLR already proved on this hardware) — thin binary protocol on the device, DAP
   translation on the host, VS Code extension on top. **Not** mp_debugpy's on-device DAP.
   Rationale in section 5.
3. **Breakpoint check in C, at the VM hook** — never a Python-level trace callback on the
   hot path. This is the single biggest differentiator from prior art (section 2.1).
4. **F5 = deploy + run + debug** in one gesture, matching the TinyCLR experience (section 7).
5. **Debug channel is a second USB CDC interface.** REPL stays on CDC0, debugger on CDC1.
6. **Fork layout: one repo, branch off a release tag.** Work happens on `sitcore-debugger`,
   branched from `v1.29.0` in the existing `ghi-electronics/micropython` fork. `master` is left
   untouched as a pure upstream mirror so GitHub's "Sync fork" always fast-forwards. The 2021
   SC13048 port is frozen at tag `sc13048-v1.15-2021` (branch `dev`), **not** rebased forward:
   of its 154 commits only ~221 lines were board definition, the rest was BrainPad / BrainGamer
   product code. Named for the SITCore family, not SC13xxx, so an SC20xxx board can join later
   without a rename. (User decision, 2026-08-31.)

7. **Our firmware is a drop-in for official MicroPython.** Anything stock MicroPython does on
   a given chip, ours does the same way: `_thread` works, the REPL is untouched, `.mpy`
   compatibility is exact, `mpremote` and Thonny keep working, and the debugger costs nothing
   observable when no host is attached. Where that collides with making the debugger simpler,
   the debugger gets harder — it is what settled the stop model in 12.3. A user should be able
   to adopt this firmware without first deciding to. (User decision, 2026-09-03.)

---

## 2. Prior art — mp_debugpy (Josverl)

- Repo: https://github.com/Josverl/mp_debugpy — MIT, ~10 stars, ~67 commits, "beta/experimental"
- Engineering notes (more valuable than the repo): https://gist.github.com/Josverl/72d11a63ab7611296addcc171528e86f
- Actual runtime lives in his micropython-lib fork: `python-ecosys/debugpy/`, branch `debugpy/jos`

**Size — the entire runtime is ~1,730 lines of Python:**

| File | Lines | Role |
|---|---|---|
| `debugpy/server/pdb_adapter.py` | 799 | breakpoints, stepping, stack, variables |
| `debugpy/server/debug_session.py` | 509 | DAP request dispatch |
| `debugpy/common/messaging.py` | 181 | JSON/DAP framing over socket |
| `debugpy/public_api.py` | 148 | `listen()`, `wait_for_client()` |
| `debugpy/common/constants.py` | 69 | DAP command constants |

**Architecture:** DAP server runs **on the device, in Python**. VS Code connects straight to a
TCP socket on the board (5678 DAP, 5679 monitor). There is no host-side adapter at all.
Hook is `sys.settrace` then `_trace_function(frame, event, arg)` then `pdb.should_stop(...)`.

### 2.1 The number that drove our architecture

From his own `performance.md`, measured on the **Unix native port (desktop CPU)**:

```
Pystone baseline, no debugger:   65,437 stones/sec
With debugpy attached:               51 stones/sec   -> 1380x slower
After a month of optimization:      120 stones/sec   ->  548x slower
```

Cause: `should_stop()` is Python, on the hot path, called on every line/call/return event.
He never published MCU numbers. A 548x slowdown at 80 MHz is not usable.

**TinyCLR does the same job for free** — see section 4.1. That contrast is the whole reason we
are building this rather than porting his.

### 2.2 What is broken / fork-only (verified 2026-08-31)

- **His submodule pin is dead.** `.gitmodules` points at micropython branch `pdb_support_jos`;
  `git ls-remote` shows it no longer exists. Surviving branches: `pdb_support`,
  `pdb_support_jv2`, `pdb_support_localvars`, `settrace_tests`, `jos/diff`.
  **The repo does not clone to a working state today.** Do not plan to build on it.
- **`MICROPY_PY_SYS_SETTRACE_SAVE_NAMES` is not upstream.** Confirmed absent from
  micropython/master `py/mpconfig.h`. It is fork-only. No local variable *names* without
  carrying a patch.

### 2.3 Hard-won findings worth stealing

These cost him real time. Treat as known, not as things to discover.

- **`f_locals` on a frozen module crashes on ESP32** — `.mpy` files carry no local name info.
  Decide the frozen-module story before writing code.
- **`@micropython.native` and `@micropython.viper` never fire trace events.** Invisible to any
  settrace-based debugger. Hooking the VM in C at least lets us *detect and report* this
  rather than silently skipping.
- **The locals dict cannot be built while GC is locked.** Constrains where variable state can
  be materialized.
- **rp2: frame locals largely unavailable.** Ports differ more than expected.
- His **stack is one frame deep on hardware** — see section 5.2, a win we get for free.

### 2.4 Its stated limits

Single-threaded only; no conditional breakpoints; no function breakpoints; limited nested
object expansion; no step-back; no hot reload. `VariableReferenceCache` is a 50-entry FIFO,
complex refs numbered from 10000. `wait_for_continue()` is a `time.sleep(0.01)` poll loop.

### 2.5 Other prior art (all dead ends)

- `wolfc01/micropython_debugger` — CLI over picocom serial, 3 stars, 7 commits, no variables,
  no DAP, no IDE. "Poor man's."
- **Thonny's debugger is CPython-only** — confirmed in `thonny/plugins/help/debuggers.rst`.
- No official MicroPython DAP roadmap. `MICROPY_PY_SYS_SETTRACE` defaults to `0` upstream.

**Conclusion: source-level MicroPython debugging over USB with a real IDE does not exist.**
That is the slot this project fills.

---

## 3. Target hardware — SC13xxx (STM32L4)

Facts read from `TinyCLR-Devices\Devices\Sc13xxx\{Device.h, Scatterfile.gcc.ldf, BuildConfiguration.txt}`.

| Property | Value | Source |
|---|---|---|
| Internal SRAM | `SRAM123 = 0x20000000, len 0x27FE0` -> **160 KB** | Scatterfile |
| Internal flash | `LR_FLASH = 0x08000000, len 0x80000` -> **512 KB** | Scatterfile |
| Flash sector | 2 KB x 256 sectors | `STM32L4_INTERNAL_FLASH_SECTOR_SIZE/COUNT` |
| Bootloader reserve | `0x6000` = 24 KB | `STM32L4_FIRMWARE_ADDRESS_OFFSET` |
| TinyCLR firmware partition | 130 sectors = **260 KB** | `STM32L4_FIRMWARE_SECTORS_COUNT` |
| External QSPI flash | 16 MB at `0x90000000`, 4 KB sectors | `STM32L4_QSPI_*` |
| Core clock | APB1/APB2 = 40 MHz -> **core 80 MHz** | `STM32L4_APB1_CLOCK_HZ` |
| Build optimization | `-size` | BuildConfiguration.txt |
| USB IDs (TinyCLR) | VID `0x1B9F`, PID `0x5012` | `USB_DEBUGGER_VENDOR_ID/PRODUCT_ID` |
| External RAM | **NONE.** `INCLUDE_FMC` is commented out in `Devices/Sc13xxx/Device.h:175` and `Targets/STM32L4xx/` ships no FMC or SDRAM driver; the 32 MB `0x60000000` region in the scatterfile is dead boilerplate from the H7 devices. **RAM budget is 160 KB internal, full stop.** | resolved 2026-08-31 |
| Exact L4 part number | **STM32L452RE**, from `#define STM32L452xx 1` in `Devices/Sc13xxx/Device.h:17`. Cross-checks clean: 512 KB flash, 160 KB SRAM, 80 MHz, USB FS device (PMA, not OTG) | resolved 2026-08-31 |

### 3.1 USB — verified, not a blocker

`Targets/STM32L4xx/STM32L4_UsbDevice.cpp:176` sets `hpcd_USB_FS.Init.dev_endpoints = 8`.
The L4 headers expose `USB_BASE` + `USB_PMAADDR` — this is the **PMA-based USB_FS device
controller, not OTG**.

Two CDC-ACM interfaces need 7 endpoints (EP0 + 3 + 3) of the 8 available. **It fits.**

**Better than expected (verified 2026-08-31 against v1.29.0):** the stm32 port already supports
multiple CDC interfaces natively. `MICROPY_HW_USB_CDC_NUM` is the single knob, and
`ports/stm32/usb.c:438` wires `USBD_MODE_CDC2` / `2xVCP` / `"VCP+VCP"` through to `pyb.usb_mode()`.
`STM32H7B3I_DK` ships `MICROPY_HW_USB_CDC_NUM (2)` as a working precedent. Locked decision 5
therefore costs **one line**, not the ~200 estimated in 8.1.

**VERIFIED ON HARDWARE 2026-08-31.** Two CDC interfaces enumerate and carry data on a real
SC13048:

```
USB\VID_1B9F&PID_F105&MI_00  ->  COM15   (REPL)
USB\VID_1B9F&PID_F105&MI_02  ->  COM14   (debug channel)
```

`0xF105` is `MICROPY_HW_USB_PID_CDC2`. On-device, `pyb.usb_mode()` reports `2xVCP`,
`pyb.USB_VCP(1).isconnected()` is `True`, and bytes move in both directions
(device -> host and host -> device both confirmed). **Locked decision 5 is settled: the debug
channel is real, and it cost one line of board config.**

Three practical findings that follow from it:

- **MSC and dual CDC are mutually exclusive.** In `2xVCP` there is no mass-storage drive. This
  promotes section 7.2's file-transfer decision from a preference to a requirement: files must
  move over the debug channel, because drag-and-drop is not available while debugging.
- **`pyb.usb_mode()` at runtime is a silent no-op.** USB is already initialised by then. It must
  be set in `boot.py`, which runs before `ports/stm32/main.c:686` applies its compile-time
  default. For a product, make `USBD_MODE_CDC2` the compile-time default instead of relying on
  a user-editable `boot.py`.
- **The CDC TX buffer is 256 bytes** (`MICROPY_HW_USB_CDC_RX/TX_DATA_SIZE`). Writes larger than
  that are short writes -- a 512-byte `write()` queues 256. The WireProtocol layer must loop on
  the return value. Not a defect; a constraint to design to.

**Throughput is not yet measured.** Attempts to measure it by driving the REPL were invalid
(they timed REPL round-trips and ignored short writes). It needs a proper on-device script with
a concurrent host reader -- worth doing before sizing the file-sync design in 7.2.

PMA is 1024 bytes total — tight, so plan **no double-buffering** on the bulk endpoints.

### 3.2 Resource risk (accepted, tracked)

MicroPython on STM32L4 is genuinely supported upstream (`B_L475E_IOT01A`, `NUCLEO_L476RG`,
`NUCLEO_L432KC`), so this is a **board port, not an architecture port**.

The real squeeze is the firmware image. Enabling trace support is not one flag — verified in
upstream `py/mpconfig.h`:

```c
#define MICROPY_PERSISTENT_CODE_SAVE (MICROPY_PY_SYS_SETTRACE)      // line 423
#define MICROPY_PY_BUILTINS_CODE (MICROPY_PY_SYS_SETTRACE ? MICROPY_PY_BUILTINS_CODE_FULL : ...)  // line 1419
#define MICROPY_PY_SYS_SETTRACE (0)                                 // line 1845
```

Turning on `MICROPY_PY_SYS_SETTRACE` **forces persistent-code-save and the full code object**:
every function keeps more metadata resident in RAM, permanently. The fork-only local-name table
adds more. **The build inflates before a single line of debugger is written.**

Good news for layout: put the `.py` filesystem on the **16 MB QSPI**, keep internal 512 KB for
firmware only. User code is then unconstrained; only the image is tight.

**MEASURED 2026-08-31 — the answer is GO.** Stock `SC13048Q` on v1.29.0 with frozen modules,
`-Os`, arm-none-eabi 8.3.1. **Both builds from clean** — an incremental build gives a false low
baseline, because objects compiled during a `FROZEN_MANIFEST=` run are not recompiled when
frozen modules are switched back on:

| build | flash | used | free | static RAM |
|---|---|---|---|---|
| baseline | 339,936 | 85.8% | 56,352 | 26,328 |
| `MICROPY_PY_SYS_SETTRACE=1` | 350,844 | 88.5% | **45,444** | 26,340 |

**Cost of the flag: +10,908 bytes flash (+3.2%), +12 bytes static RAM.** Materially cheaper than
feared — `MICROPY_PERSISTENT_CODE_SAVE` and `MICROPY_PY_BUILTINS_CODE_FULL` cost about 11 KB, not
the runaway inflation section 3.2 originally warned about. Against a section 8.1 debug-engine
estimate of roughly 15-25 KB compiled, 45 KB of headroom is workable but not generous.

**No QSPI. (User decision, 2026-09-01: SC13 boards are planned without it.)** Everything runs
from the 512 KB internal flash and always has -- there is no QSPI driver, config or dependency
anywhere in the board. Section 3's external 16 MB QSPI belongs to the TinyCLR SC13xxx hardware
and is not available here, so the filesystem stays on internal flash.

**The lever that replaces it:** the FLASH / FLASH_FS boundary in the linker script is one number.
Firmware is currently at 90.2% of its 384 KB region with 38.5 KB free, and the filesystem has
113 KB usable, which is far more than `.py` source needs (the blink test script is 189 bytes).

| Split | Firmware free | Filesystem |
|---|---|---|
| 384K / 128K (current) | 38,548 | ~113 KB |
| 416K / 96K | 71,316 | ~82 KB |
| 448K / 64K | 104,084 | ~50 KB |

Not needed yet: the remaining device work (stack walk, stepping, variables) is estimated at
10-15 KB. Move the boundary if variables run it close.

**Caveat, still unmeasured:** static RAM barely moved, but that is not where settrace costs RAM.
The real price is per-function code-object metadata retained in the **GC heap** at runtime. The
baseline board reports `gc.mem_free() = 132,624`; flashing `build-settrace` and re-reading it
gives the number directly.

### 3.3 Useful upstream hooks (verified present)

`py/mpconfig.h` lines 748-759 define `MICROPY_VM_HOOK_INIT`, `MICROPY_VM_HOOK_LOOP`,
`MICROPY_VM_HOOK_RETURN`. **`MICROPY_VM_HOOK_LOOP` is the intended insertion point** for the
breakpoint check — it already exists for exactly this class of periodic work.

---

## 4. TinyCLR device side — the blueprint

| File | Lines | Note |
|---|---|---|
| `TinyCLR-Core/CLR/Debugger/Debugger.cpp` | 2,982 | the engine |
| `TinyCLR-Core/CLR/Include/TinyCLR_Debugging.h` | 1,031 | full command set + structs |
| `TinyCLR-Core/Support/WireProtocol/WireProtocol.cpp` | 375 | framing — **small, transliterate this** |
| `TinyCLR-Core/Support/Include/WireProtocol.h` | — | `MARKER_DEBUGGER_V1 "GHIDBG1"`, `MARKER_PACKET_V1 "GHIPKT1"` |

### 4.1 The hot path — why TinyCLR is free and his is 548x

`CLR/Core/Interpreter.cpp:659`:

```cpp
while (HasQuantumTimerExpired() == FALSE && !CLR_EE_DBG_IS(Stopped)) {
```

`CLR_EE_DBG_IS` (`TinyCLR_Runtime.h:2616`) is a bitmask test against a global. One AND, one
compare, per dispatch. **Replicate this exactly**: a global "debugger armed" flag tested in
`MICROPY_VM_HOOK_LOOP`, with the expensive breakpoint-table lookup only behind it.

### 4.2 Key call sites to mirror

| TinyCLR | Location | MicroPython equivalent |
|---|---|---|
| halt pump | `Execution.cpp:2956` `DebuggerLoop()` | spin in the VM hook, pump CDC1, never unwind |
| breakpoint hit | `Execution.cpp:3025` `StopOnBreakpoint()` | send `BreakpointHit` event, set Stopped |
| step hook | `Interpreter.cpp:3108/3157/3179`, `Thread.cpp:665` `Breakpoint_StackFrame_Step()` | line-boundary step check |
| hit queue | `TinyCLR_Runtime.h:2585-2589` `m_breakpointsActive[5]` | queue of *hit* breakpoints, not a set-limit |

### 4.3 Command ID map (for our own `micropython_debugging.h`)

```
0x00020000-09  Execution_*   BasePtr, ChangeConditions, Breakpoints, BreakpointHit, BreakpointStatus, QueryCapabilities
0x00020010-18  Thread_*      List, Stack, Kill, Suspend, Resume, GetException, Unwind
0x00020020-21  Stack_*       Info, SetIP
0x00020030-3B  Value_*       ResizeScratchPad, GetStack, GetField, GetArray, GetBlock, SetBlock, Assign, Allocate*
0x00020040-55  TypeSys_/Resolve_*   <-- mostly DEAD WEIGHT for Python, see section 5
0x000200B0     Deployment_Status
```

Our MVP needs roughly 15 commands, not 50. Keep the numbering scheme so the framing and any
reused host code stays familiar.

---

## 5. TinyCLR host side — the reuse map

`TinyCLR-SDK\GHIElectronics.TinyCLR.Debugger` = **21,076 lines C#**.
`TinyCLR-VSCode\DebugServer` = **5,177 lines C#**. `TinyCLR-VSCode\src` = **2,288 lines TS**.

| Component | Lines | Reuse verdict |
|---|---|---|
| `AsyncStreams/WinUsbStream.cs` + `WinUsb/WinUsbDevice.cs` | 1,018 | **AS-IS.** The USB transport nobody else has. |
| `PortDefinitions/*`, `DeviceEnumerator.cs`, `SerialPortNaming.cs` | ~260 | **AS-IS.** |
| `PortDefinitions/PortDefinition_Tcp.cs` | 229 | **AS-IS — see 5.3, strategically important** |
| `WireProtocol/*.cs` (WireProtocol, Controller, MessageReassembler, Converter) | 2,276 | **AS-IS** if we keep the `GHIPKT1` packet format |
| VS Code ext: `debugAdapterFactory`, `debugConfigProvider`, `deviceManager`, `deployGate`, `debugLaunchProgressTracker` | ~800 | **~90%**, retarget only |
| `DebugServer/DapServer.cs` | 2,198 | structure yes, bodies ~half rewritten |
| `Engine.cs` | 3,788 | shape yes; the `Resolve_Type/Field/Method/Assembly` half is dead weight |
| `BinaryFormatter.cs` | 2,010 | mostly no — serializes CLR type descriptors |
| `DebugServer/SymbolStore.cs` | 929 | **evaporates** — Python source *is* the symbol table |
| `DebugServer/GenerateResource.cs`, `PeBuilder.cs` | 1,716 | not applicable |
| `ArmDisassembler.cs`, `Management/*` | ~5,000 | not applicable |

### 5.1 The seam to reuse

`DapServer.cs` header comment documents it exactly:

```
VS Code -> setBreakpoints -> Engine.SetBreakpoints()
VS Code -> stackTrace     -> Engine.GetStackFrameInfo()
VS Code -> variables      -> Engine.GetStackFrameValueAll()
VS Code -> continue       -> Engine.ResumeExecution()
VS Code -> evaluate       -> Engine.CreateThread()  (funceval on device)
```

**Swap what is behind `Engine`; keep everything in front of it.**

### 5.2 Two places MicroPython is genuinely EASIER than TinyCLR

- **Expression evaluation.** TinyCLR needs `CreateThread` + funceval + scratchpad. In
  MicroPython you compile and eval a string in the frame's globals/locals — a few dozen lines.
- **Full stack walk.** mp_debugpy is limited to one frame because the *Python-level* frame
  object lacks `f_back`:
  ```python
  # MicroPython doesn't have f_back attribute
  if hasattr(frame, "f_back"): frame = frame.f_back
  else: break   # Only return the current frame for MicroPython
  ```
  That is a limit of the exposed object, **not the VM** — at C level `mp_code_state_t` carries
  a `prev` pointer. Walking it in C gives a genuine full stack. **Visible, demoable win.**

Also gone entirely: MSBuild, MMP, `.pe` generation, assembly-index resolution, PDB parsing,
metadata token resolution.

### 5.3 Transport is already a swappable seam — exploit it

`PortDefinition_Tcp.cs` sits right next to `WinUsbStream.cs` in the same library. The same
`Engine`, the same `DapServer`, the same extension can drive a device over **TCP or USB with no
host-side changes**.

That means the device-side C engine can be developed against the **MicroPython Unix port over
TCP** — seconds-long edit/run cycles, gdb available, no flashing — and then swapped to USB with
zero host rework. Not a detour; it uses code we already own. Recommended even though SC13xxx is
the only shipping target.

---

## 6. Architecture

```
 VS Code (TypeScript, DebuggerExtension/)
    | DAP over stdio
 DapServer (C# net48)  <-- DAP translation lives HERE, not on the device
    |
 Engine (C#)  -->  WireProtocol (GHIPKT1 framing)
    |
 WinUsbStream / PortDefinition_Tcp
    |  USB CDC1  (CDC0 = REPL, untouched)
 ===================== device =====================
 Debug engine (C, in the MicroPython tree)
    |  MICROPY_VM_HOOK_LOOP -> armed flag -> breakpoint table
 MicroPython VM
```

**Why not his single-tier design:** putting DAP on the device costs RAM, requires a JSON parser
on an 80 MHz MCU, requires a network stack, and puts the hot path in Python. Every one of those
is a problem on SC13xxx specifically.

---

## 7. F5 flow

Reference implementation: `TinyCLR-VSCode\DebugServer\DapServer.cs` lines 709-775 (numbered
comments), `HandleConfigurationDone` at line 921.

| TinyCLR today | MicroPython |
|---|---|
| 1. Resolve output dir, find `.pe` files | Collect workspace `.py` files |
| 2. Connect to device | **identical** — same `WinUsbStream` |
| 3. `Deployment_Execute` (no reboot) | Push changed `.py` files to device FS |
| 4. `RebootDevice(RebootClrWaitForDebugger)` | **NEW PRIMITIVE — must be built, see 7.1** |
| 5. Reconnect after reboot | likely free — soft reset should not re-enumerate USB |
| 6. Load symbols (`.pdbx` + portable `.pdb`) | **gone** |
| 7. Enable source-level debugging | arm the debug engine |
| 8. Subscribe to device events | **identical** |
| 9. `initialized` -> wait `configurationDone` -> resume | **identical** |

### 7.1 The one new primitive

`RebootClrWaitForDebugger` has no MicroPython equivalent. Needed: **on next VM start, halt
before the first bytecode and pump the debug channel** — the equivalent of
`CLR_EE_DBG_IS(Stopped)` being set at boot.

Without it F5 is a race: the script finishes before VS Code sends `setBreakpoints`, and a
breakpoint on line 1 never hits. **Nothing else works until this exists.**

### 7.2 Design decisions for F5

- **File transfer over the debug channel, not the REPL.** `mpremote` raw-paste is slow, fragile,
  and fights the user's REPL. Add `File_Put` / `File_List` / `File_Delete` / `File_Crc` commands
  to our protocol — the `Deployment_Execute` pattern with a simpler payload.
- **Incremental sync by CRC.** At 80 MHz over full-speed USB, re-pushing an unchanged project
  every F5 wastes seconds. Hash first, send only what changed.
- **Sync the workspace, run an entry file** — not just the open editor. Imports must be present
  or F5 fails confusingly. `program` field in `launch.json`, default `main.py`.
- **Route `print()` into the Debug Console.** REPL on CDC0 means prints land on the wrong pipe by
  default. `Engine` already has `ConsoleOutputEventHandler`; `DapServer.cs:809` already emits DAP
  `output` events. Forward device stdout there while a session is attached.

Target `launch.json`:

```json
{
    "type": "micropython",
    "request": "launch",
    "name": "Deploy and Debug (MicroPython, USB)",
    "program": "${workspaceFolder}/main.py",
    "transport": "usb",
    "device": ""
}
```

---

## 8. Feasibility summary — can we match TinyCLR?

| Feature | Verdict |
|---|---|
| Breakpoints | **Yes.** C check at `MICROPY_VM_HOOK_LOOP`, gated on an armed flag. Line table is in the bytecode prelude. |
| Stepping (over/in/out) | **Yes.** Frame-identity comparison, same as his, but in C. |
| Call stack | **Yes, and better than prior art** — walk `mp_code_state_t->prev` in C (5.2). |
| Variables (locals/globals) | **Yes, but this is the hard part.** Needs local *names* -> fork-only flag or our own prelude name table. Frozen `.mpy` is the landmine (2.3). |
| Expression evaluation | **Yes, and easier than TinyCLR** — compile+eval a string in frame context. |
| Threads | Deferred. Single-threaded model to start, like his. |

### 8.1 Effort estimate

| Piece | Estimate |
|---|---|
| WireProtocol in C on device (transliterate `WireProtocol.cpp`, 375 lines) | ~400 lines |
| Debug engine in C (breakpoints, step, stack walk, value encode, halt loop) | 1,200-1,800 lines |
| MicroPython core patches (line table, local names, VM hook) — carried as a fork | 300-600 lines |
| Second USB CDC interface + port config | **~1 line** — `MICROPY_HW_USB_CDC_NUM (2)`, already upstream (3.1) |
| Host-side engine (replacing `Engine.cs`'s device half) | 1,000-1,500 lines C# |
| `DapServer.cs` retarget | ~1,000 lines changed |
| VS Code extension retarget | ~300 lines changed |
| **SC13048 board port for MicroPython** | **largely done** — a 2021 board definition (5 files, ~221 lines) has been carried onto v1.29.0 and now compiles. Remaining: verify pins on hardware, REPL routing, QSPI filesystem |

**2-4 months to a solid MVP** for one experienced person — breakpoints, step, full stack,
locals/globals, over USB. Variable-expansion depth and frozen-module support are the long tail.
From scratch (without the TinyCLR host stack) it would be roughly a year.

---

## 9. Traps

### 9.1 Carried from TinyCLR (already paid for once — do not pay again)

- **QSPI `FlashSize` must be `POSITION_VAL(W25Q128_QSPI_FLASH_SIZE)`, NOT `- 1`.** The
  "mathematically correct" `-1` was a 3.0 regression of a deliberate 2.0 erratum workaround:
  memory-mapped reads at the FSIZE boundary corrupt the AHB transaction and trash the caller's
  stack frame. **A fresh QSPI driver in a fresh tree is exactly where this comes back.**
- **QSPI + Sleep:** power-down must abort memory-mapped/XIP mode first, or the indirect command
  never raises TCF and the transfer macro spins forever. Skip power-down entirely on shutdown —
  deep power-down survives MCU reset and leaves the board unbootable until a power cycle.
- **The debugger-pump cadence rule.** TinyCLR's `WaitForActivity()` only tested `m_threadsReady`,
  so a fully idle app made the CLR sleep up to 60 s and the host tool gave up.
  **Exact twin here:** a `time.sleep(60)` or any blocking C-level call makes the debugger deaf,
  and Pause / breakpoint-set both time out. **Pump in the sleep path from day one.**
- **Debugger-attached timing is unreliable.** Always ask "is the debugger attached?" before
  investigating an apparent performance regression.
- **STM32L4 specifics:** PWM channels on a timer share one frequency; FDCAN on L4 is classic
  bxCAN (H7-to-L4 interop needs `FDCAN_FRAME_CLASSIC` on the H7 side).
- **STM32 I2C slave:** `HAL_I2C_Init` leaves `CR2.NACK` set — clear it after Init and inside
  `I2C_ITSlaveCplt`. Applies to L4.
- **GPIO is a single flat controller:** `port*16 + pin` (PA0=0, PB0=16, PC0=32, PH0=112).

### 9.1a Discovered building this (2026-09-01)

- **Anything the debug engine does that blocks can re-enter itself.** `mp_hal_delay_ms()` runs
  the idle behaviour, which fires `MICROPY_INTERNAL_EVENT_HOOK` -> `mp_debug_event_hook()` ->
  `mp_debug_poll()`. A reboot path that delayed with it recursed until the board wedged
  mid-teardown. Use `mp_hal_delay_us()` (busy-wait) inside the engine, and clear one-shot flags
  *before* acting on them. This applies to the halt loop and to file transfer.
- **A scheduled `SystemExit` is not a soft reset.** `pyexec` only converts it when it unwinds
  into its own `nlr_push`; raised from the idle hook while the REPL is in `readline()` it
  surfaces outside that guard and hits the fatal handler. Return
  `BOARDCTRL_GOTO_SOFT_RESET_EXIT` from the run-main-py board hook instead.
- **`.bss` survives a soft reset but not a hard one.** State that must cross a hard reset needs
  an RTC backup register. Those need the RTC APB clock and backup-domain write access but not a
  running RTC -- relevant here because `MICROPY_HW_ENABLE_RTC` is 0.
- **Serial ports must be closed in a `finally`.** A port left open by an interrupted host script
  survives the process on Windows; the device re-enumerates underneath the stale handle and every
  later open fails until the board is replugged. Cost several confusing rounds.

### 9.2 Discovered from mp_debugpy

- Frozen `.mpy` has no local name info — `f_locals` crashed on ESP32. Decide the story early.
- `@micropython.native` / `@micropython.viper` never fire trace events. Detect and report.
- Locals dict cannot be built while GC is locked.
- `MICROPY_PY_SYS_SETTRACE` silently pulls in `MICROPY_PERSISTENT_CODE_SAVE` and
  `MICROPY_PY_BUILTINS_CODE_FULL` — measure the image before committing (3.2).

### 9.3 Working conventions

- MicroPython C changes are carried as a **fork** in `Firmware/`. Keep them isolated and small
  enough to rebase onto upstream — a maintenance cost for the life of the product.
- Never edit the TinyCLROS tree from this project. Read-only reference.
- Never hardcode a version number or machine-specific path.

---

## 10. Milestone plan

1. **Board port.** DONE (2026-08-31), except QSPI: MicroPython v1.29.0 boots on SC13048, REPL on
   USB CDC0, filesystem on 100 KB of internal flash. QSPI filesystem still outstanding.
2. **Second CDC + framing.** DONE (2026-08-31). `Ping` round-trips over CDC1 from the host:
   `flags=0x8002` (ACK|Reply), `seqReply` matches, header and payload CRCs verify both ways.
3. **F5 end-to-end, no breakpoints yet.** File push + `wait_for_debugger` reset + run.
   *First visibly working milestone — proves transport, file path, reset primitive.*
   **DONE 2026-09-01.** File push, host-driven reboot into halt, and resume all work over
   CDC1 with no REPL interaction. What is missing for a real F5 is only the host side: a DAP
   server driving these commands from VS Code.
4. **Breakpoints and halt.** DONE 2026-09-01. VM hook, armed flag, breakpoint table, halt
   loop and `BreakpointHit` all working on hardware; hit reported at `main.py:6`, halted,
   resumed, hit again.
   *(The VM hook, the armed flag and the halt loop already exist -- only the breakpoint table
   and `BreakpointHit` remain.)*
5. **Stack.** DONE 2026-09-01. Walks `code_state->prev_state`; reports every frame with
   file, line and function name. NOTE: `frame->back` is a trap -- it exists but is never
   linked (py/profile.c sets it NULL and only a Python trace callback would build it).
6. **Variables.** Locals/globals, then expansion.

Run the 3.2 flash/RAM measurement spike **before or alongside milestone 1** — the cheapest
possible answer to the go/no-go question.

---

## 11. Status and next action

Last updated 2026-09-03. Device protocol **v10**.

**SC13xxx is done.** Everything in this section is verified on hardware. The next phase is
porting to other boards, starting with Pico 2 — section 12.

**The debugger is usable.** F5 in VS Code deploys the workspace, restarts the board into a halt,
applies breakpoints, runs, and stops where it should. Verified on real SC13048 hardware.

| Capability | Device command | DAP |
|---|---|---|
| Deploy on F5, skipping unchanged files by CRC | `File_Put` / `File_Crc` / `File_Delete` | `launch` |
| Halt before the first bytecode, then set breakpoints | `Monitor_Reboot` + `Execution_Breakpoints` | `launch`, `setBreakpoints` |
| Breakpoints, pause, continue | `Execution_ChangeConditions` | `continue`, `pause` |
| Step over / in / out | `Execution_Step` | `next`, `stepIn`, `stepOut` |
| Full call stack: file, line, function | `Thread_Stack` | `stackTrace` |
| Global variables with names and values | `Value_GetScope` | `scopes`, `variables` |
| Expand lists, tuples, dicts and class instances, nested and paginated | `Value_GetChildren` | `variables` |
| Edit a value in the Variables panel | `Value_SetVariable` | `setVariable` |
| Watch, hover, Debug Console prompt | `Value_Evaluate` | `evaluate` |
| `print()` in the Debug Console, dropping rather than stalling when full | `Monitor_Output` event | `output` |
| Halt at the raise point of an uncaught exception | `Execution_Stopped` reason=exception | `stopped` |
| Local variables: arguments named from the bytecode, the rest verified against source | `Value_GetScope` scope=locals | `scopes`, `variables` |
| Conditional breakpoints and hit counts | host-side, via `Value_Evaluate` | `setBreakpoints` |
| Filesystem size, checked before a deploy starts | `File_Stat` | `launch` |
| Deploy `.mpy` and, on request, data files | `File_Put` | `launch` |
| Multi-file projects: subdirectories, per-path breakpoints, stale-file removal | `File_List` / `File_Mkdir` / `File_Delete` | `launch`, `setBreakpoints` |
| Stop from the toolbar in one click | `Monitor_Reboot` | `terminate`, `disconnect` |

Device engine: ~1,200 lines of C in `ports/stm32/mpdebug/`, plus three one-line hooks in
`py/vm.c` and `ports/stm32/mphalport.c` with empty defaults in `py/mpconfig.h`.
Build 2026-09-02: text 358,420, `.bss` 31,900 — **~34.8 KB flash free**. No QSPI.
Extension: TypeScript, in-process debug adapter, one VSIX, no .NET or Python dependency.

**Not a one-board design.** SC20xxx (STM32H7, SDRAM, display, network) is planned. It is the
same `ports/stm32`, so `mpdebug/` carries over essentially unchanged; the sizing limits are
`#ifndef`-guarded so a larger part raises them from its own `mpconfigboard.h`.

### 11.0 Accepted limitations

Reviewed and accepted 2026-09-02. These are decisions, not a backlog.

1. ~~**No local variables.**~~ **SOLVED 2026-09-02, and the earlier reasoning was
   incomplete.** It said locals were blocked because naming them meant changing the bytecode
   prelude, which would break stock `.mpy` compatibility. That is true of putting names *on the
   device*. It is not the only route.

   Two things make it work with **no format change at all**:

   - **Argument names are already in the bytecode.** The prelude is followed by the block name
     and one qstr per positional and keyword-only argument, because the VM needs them to bind
     keyword arguments (`py/bc.c`, and `mp_prof_extract_prelude` shows the layout). The device
     reads them back exactly, at no runtime cost, and it works inside a `.mpy` because the qstr
     table is stored there too.
   - **The rest are derived on the host** from the source, in `src/localNames.ts`: the compiler
     allocates a slot the first time a function binds a name, in source order.

   The derivation is **verified, not trusted**. The device's argument names are authoritative,
   so if the derived order disagrees about them the analysis has failed for that function and
   nothing past the arguments is named. Names are matched to slots by position, so one missed
   binding would shift every later name onto the wrong value -- silently. Refusing to guess is
   the feature.

   Not solved: which slots past the arguments are locals rather than value stack. `n_state`
   covers both and the boundary is recorded nowhere, so the device sends every slot in order
   (unassigned ones with an empty value, to keep positions aligned) and the host stops naming
   when its own list runs out.

   Verified on hardware: stopped inside `compute(alpha, beta, scale=2)` containing a `for`
   loop, `lo, hi = alpha, beta` and `total += i * scale`, the panel showed
   `alpha=10 beta=20 scale=2 total=6 i=2 lo=10 hi=20`, and correctly omitted `result` because
   execution had not yet reached its assignment.

2. ~~**No conditional breakpoints or hit counts.**~~ **DONE 2026-09-02**, evaluated on the
   host. The device stops on every hit and the adapter checks the condition in the halted frame
   through `Value_Evaluate`, resuming quietly when it is false, so VS Code sees only the stops
   that matter. Deliberately not done on the device: that would mean running Python from the
   instruction hook, which is what caused the eval-reentrancy bug (section 9). A round trip per
   hit is the cheaper mistake. A condition that fails to evaluate stops rather than swallowing
   the hit. Hit counts accept `5`, `>5`, `>=5`, `==5`, `<5`, `%5`.
3. **No caught-exception filters.** The uncaught test is conservative: an active `try` block
   whose `except` would not match still suppresses the halt. Deliberate -- stopping on handled
   exceptions makes the debugger unusable on code that uses `try/except` for control flow.
4. **First deploy of a large project is slow; everyday edits are not.** Measured 2026-09-02
   on an SC13048, deploying the way F5 does:

   | Case | Time |
   |---|---|
   | One-file project, first deploy | 237 ms |
   | One-file project, nothing changed | 3 ms |
   | One-file project, after an edit | 237 ms |
   | 9 files / 20.7 KB, first deploy | 4.8 s |
   | 9 files / 20.7 KB, nothing changed | 37 ms |
   | 9 files / 20.7 KB, after editing one | 359 ms |

   Roughly **230 ms per KB of changed content**, and nothing for unchanged files. The
   interactive loop is 240-360 ms, less than the 1.2 s USB reconnect that follows the reboot.
   Accepted as good enough; the remaining cost is understood, see 11.6.
5. ~~**No `.mpy` or data-file deployment.**~~ **DONE 2026-09-02.** `.py` and `.mpy` are both
   deployed and both debug: verified on hardware that a breakpoint inside `lib/greet.mpy` hits,
   with the stack reading `greet.py:2 in hello()`. Data files are opt-in through an `include`
   glob list in `launch.json`, because the filesystem is small enough that sweeping in a stray
   binary matters. `removeStale` covers `.mpy` too, and a deploy warns when a `.py` and `.mpy`
   exist for one module -- MicroPython prefers the `.mpy`, so a stale one silently wins and
   puts breakpoints at the line numbers it was compiled with.
6. ~~**No filesystem-space warning.**~~ **DONE 2026-09-02.** `File_Stat` reports block size and
   usage; a deploy logs the free space and refuses up front if the project cannot fit.
   Note for anyone extending this: `statvfs("/")` does **not** fail when nothing is mounted at
   the root, it returns a tuple of zeros with a success code (`extmod/vfs.c`). Ask about the
   current directory instead.

**Zero Python-visible surface on the device.** The debugger is entirely C: the wire protocol,
breakpoint table, halt loop and USB binding are driven from the VM hook, and nothing is
deployed to the filesystem. The `mpdebug` bring-up module is guarded by
`MICROPY_PY_MPDEBUG_MODULE`, which defaults to 0 in `py/mpconfig.h` and is set by no board --
verified absent from the build's `genhdr/moduledefs.h`. So user code cannot import, inspect or
disturb the debugger, there is no `boot.py` to collide with, and a program that wedges the
interpreter does not take the debugger down with it. Worth keeping that way: it is the
difference between a debugger that is part of the firmware and one that is a library the
program has to cooperate with.

Not a limitation: **threads**. `MICROPY_PY_THREAD` is 0 in the stm32 port and on this board, so
`_thread` does not exist and there is nothing for the debugger to miss. If SC20xxx enables it,
that is a design change to the stop model, not a gap in this one -- see 11.5 item 5.

### 11.1 Resolved since the research session

| Was open | Now |
|---|---|
| Exact L4 part | **STM32L452RE** (section 3) |
| External RAM populated? | **No** — 160 KB internal is the whole budget (section 3) |
| Which MicroPython to fork | **v1.29.0**, tagged 2026-08-24. Branch `sitcore-debugger` (decision 6) |
| Does an SC13048 port exist? | **Yes** — GHI ported it in 2021 on v1.15, frozen at tag `sc13048-v1.15-2021`. Its 5 board files (~221 lines) were carried onto v1.29.0 rather than rebasing 154 commits of BrainPad product code |
| Cost of the second CDC | **~1 line** — upstream has `MICROPY_HW_USB_CDC_NUM` (section 3.1) |
| **Does settrace fit on SC13048?** | **Yes — measured. +10,908 bytes flash, 45 KB free** (section 3.2) |

### 11.2 Building on Windows (the working recipe)

Windows is the chosen build host. Two Windows-specific obstacles, both solved:

**1. `mpy-cross` needs a *host* compiler, and there is none.** `c:\gcc` is the ARM cross
toolchain (`arm-none-eabi` 8.3.1, 2019); there is no `gcc`/`cc`/`clang` for the host, so
`mpy-cross` cannot be compiled from source. **Solution: use the prebuilt wheel from PyPI**,
which publishes a version matching every release:

```
python -m pip install "mpy-cross==<same version as the pinned tag>"
```

Then point the build at it, computing the path rather than hardcoding it:

```bash
MPYX=$(python -c "import mpy_cross;print(mpy_cross.mpy_cross)")
make -C ports/stm32 BOARD=SC13048Q MAKE=make \
     MICROPY_MPYCROSS="$MPYX" MICROPY_MPYCROSS_DEPENDENCY="$MPYX" -j8
```

`MICROPY_MPYCROSS` is defined at `py/mkenv.mk:52`; a command-line assignment overrides it and
also stops `py/mkrules.mk:204` from trying to build mpy-cross from source.

`MAKE=make` is needed because Git's make lives at `C:\Program Files\Git\usr\bin\make.exe` and
the recursive `$(MAKE)` invocation is unquoted, so the space splits the command.

**Run builds from Git Bash.** A cmd.exe equivalent exists but the `for /f` capture of the
mpy-cross path is easy to get wrong; a malformed `MICROPY_MPYCROSS` silently drops frozen
content and the link then fails with `undefined reference to mp_find_frozen_module`. If that
happens, `make ... clean` and rebuild -- the incremental state cannot recover on its own.

Full command set, from the repo root:

```bash
# one-time
python -m pip install "mpy-cross==<version matching the pinned tag>"
make -C ports/stm32 submodules

# every build
MPYX=$(python -c "import mpy_cross;print(mpy_cross.mpy_cross)")
make -C ports/stm32 BOARD=SC13048Q MAKE=make \
     MICROPY_MPYCROSS="$MPYX" MICROPY_MPYCROSS_DEPENDENCY="$MPYX" -j8

# debugger-enabled variant, separate build dir so the baseline survives
make -C ports/stm32 BOARD=SC13048Q MAKE=make \
     MICROPY_MPYCROSS="$MPYX" MICROPY_MPYCROSS_DEPENDENCY="$MPYX" \
     BUILD=build-settrace CFLAGS_EXTRA=-DMICROPY_PY_SYS_SETTRACE=1 -j8

# clean
make -C ports/stm32 BOARD=SC13048Q clean
```

Artifacts land in `ports/stm32/build-SC13048Q/`: `firmware.bin` (raw, **no address inside** --
must be written at `0x08006400`), `firmware.hex` (carries the address, safest), `firmware.dfu`,
`firmware.elf` (symbols, for gdb), `firmware.map`.

**2. The link line exceeds the Windows 8,191-character argument limit.** 396 objects produce a
14,588-character link line; `readline.o` is severed at offset 8170. `BUILD=b` only reaches
9,440, so shortening paths cannot fix it. **Solution: a linker response file** — the one patch
carried in this fork, a single line in `ports/stm32/Makefile`:

```make
define GENERATE_ELF
	$(ECHO) "LINK $(1)"
	$(Q)$(file >$(BUILD)/objects.rsp,$(2))$(CC) $(LDFLAGS) -o $(1) @$(BUILD)/objects.rsp $(LDFLAGS_MOD) $(LIBS)
```

`$(file >...)` needs GNU Make 4.0+. This is a genuine upstream portability gap, so it is a
candidate to submit upstream rather than carry forever.

**Deferred, not rejected:** WSL Ubuntu is installed and would avoid both issues with no patch,
plus give a modern toolchain and the Linux host that section 5.3's Unix-port development path
needs. Revisit if the Windows route costs more than it saves. (User chose Windows, 2026-08-31.)

### 11.3 Next actions, in order

Everything from the 2026-09-02 review is done except item 1 below. Item 2 is decided and
waiting on the Pico 2 port to be built.

1. **Caught-exception filters.** The uncaught test is conservative: an active `try` whose
   `except` would not match still suppresses the halt. Making it exact means deciding, in C at
   the raise point, whether any enclosing handler would match -- and getting it wrong in the
   permissive direction makes the debugger unusable on code that uses `try/except` as control
   flow. Deferred, not rejected.

2. ~~**The threading model.**~~ **DECIDED 2026-09-03: all-stop, single debug owner.** The
   model, the code facts behind it, and the two remaining assumptions to verify are in 12.3.
   SC13xxx is unaffected — `MICROPY_PY_THREAD` is 0 there — beyond a thread id in the protocol
   that it always reports as 1. Implementation lands with the Pico 2 port, not before.

Smaller, if they ever matter: `Value_SetVariable` for locals (a slot is not a binding the
device can assign by name), and expanding containers that are not list/tuple/dict/instance.

**Everything else for SC13xxx is finished.** The next work is section 12 (Pico 2). Its stop
model is now decided (12.3), so the second CDC — 12.4 step 2 — is the next thing to build.

### 11.4 What exists in the tree

**Device engine, `ports/stm32/mpdebug/` (~1,200 lines C):**

| File | Role |
|---|---|
| `wireprotocol.c/.h` | 32-byte header, table-free CRC-32, receive state machine with resync |
| `mpdebug.c/.h` | CDC1 binding, dispatch, halt loop, VM/idle pumps, output back-pressure |
| `mpdebug_break.c` | breakpoint table, stepping, stack serialise |
| `mpdebug_files.c` | `File_Put` / `Crc` / `Delete` / `Mkdir` / `List`, all `nlr_push`-wrapped |
| `mpdebug_vars.c` | globals, object handles, children, evaluate, set-variable |
| `micropython_debugging.h` | command IDs, TinyCLR numbering, `#ifndef`-guarded sizing limits |

Locals are reported from `mpdebug_vars.c`: **argument names are read out of the bytecode**
(the prelude is followed by the block name and one qstr per argument, which is how the VM binds
keyword arguments -- `py/bc.c`, layout in `mp_prof_extract_prelude`). Exact, free at runtime,
and works inside a `.mpy`. Every other slot is sent unnamed and in order, including unassigned
ones with an empty value, because position is the only thing tying a slot to a name.

Breakpoint paths match by **suffix on a path boundary**: `lib/x.py` matches `/flash/lib/x.py`,
and `util.py` does *not* match `mathutil.py`. 16 breakpoints, 128-character paths; asking for
more than fits costs you the extras, not the whole set.

The CRC is bitwise rather than TinyCLR's 256-entry table -- verified to reproduce that table
exactly (all 256 entries plus random vectors) before any C was written. Saves 1 KB of flash,
which is the scarce resource here.

**Port patches (small, isolated, both upstream-submission candidates):**

- `ports/stm32/Makefile` -- `GENERATE_ELF` emits a linker response file (Windows 8,191-char limit)
- `ports/stm32/usb.c` -- `usb_vcp_get_cdc_itf()` accessor; `usb_device` is file-static there
- `boards/SC13048Q/mpconfigboard.h` -- `MICROPY_VM_HOOK_LOOP` -> `mp_debug_vm_hook()`

**Host side, `DebuggerExtension/micropython-vsc-extension/`** (repo
`ghi-electronics/micropython-vsc-extension`): `wireProtocol.ts` (framing), `deviceLink.ts`
(transport and commands), `debugSession.ts` (DAP translation), `localNames.ts` (recovering
local names from source), `extension.ts`. `build-extension.bat` compiles and packages.

`localNames.ts` derives the non-argument locals: the compiler allocates a slot the first time a
function binds a name, in source order, so walking the body in order reproduces it. It handles
`for` targets, tuple unpacking, `with`/`except ... as`, augmented assignment, nested `def` and
`class`, and imports, and excludes attribute/subscript targets and `global`/`nonlocal` names.
**The result is verified, never trusted**: the device's argument names are authoritative, and if
the derived order disagrees about them nothing past the arguments is named. Names map to slots
by position, so one missed binding would shift every later name onto the wrong value silently.

Tests under `test/` split two ways: `findports`, `collect`, `localnames` and
`breakpoint_logic` need no hardware; `link`, `dap_sequence`, `deploy_speed`, `bisect`,
`busyloop` and `concurrent` drive a real board without VS Code. `DebuggerExtension/tools/*.py` are the original
Python reference clients -- scaffolding, kept for reference only.

**Board state:** the USB layout is chosen at boot from the **MODE pin (PA15)** by
`boards/SC13048Q/board_usb_mode.c` -- high gives `VCP+VCP` for debugging, low gives
`VCP+MSC` for the file drive. **There is no drive in dual-CDC mode**; MSC and dual CDC are
mutually exclusive. The **RUN_APP pin (PB7)** held low boots to safe mode without running user
code. A pin was chosen over `boot.py` because a filesystem wipe would take a `boot.py` with it
and leave no way to influence the mode. The pin map itself is provisional and gets reworked
once the rest is settled.

### 11.5 Open problems

1. **Unexplained entry into the STM32 system bootloader.** After a `machine.reset()` that changed
   USB mode, the board came up in the ST ROM bootloader rather than running firmware. It
   recovered on reflash and has not reproduced. **Prime suspect: `MICROPY_HW_USRSW_PIN (pin_C13)`,
   inherited verbatim from NUCLEO-64**, colliding with whatever SC13048 uses PC13 for. Chase this
   before breakpoints land -- an unexplained path into the bootloader is far harder to debug once
   the VM is being halted deliberately.
2. ~~**A soft reset across a USB-mode change does not re-enumerate.**~~ **FIXED 2026-09-01.**
   The cause was `NVIC_SystemReset()` leaving the D+ pull-up asserted through the reset, so the
   host never saw a disconnect and kept a device object that no longer matched the rebooted
   device. On Windows the port still enumerated and reported OK while every open failed with
   "a device attached to the system is not functioning" until the board was physically
   replugged. `pyb_usb_dev_deinit()` before the reset makes reboots self-recovering, and the
   host now reconnects unaided. Section 7 step 5's assumption holds again.
3. **Inherited board facts, partly verified.** Confirmed on hardware: **LED1 = PA8**,
   **MODE = PA15**, **RUN_APP = PB7**. `MICROPY_HW_HAS_SWITCH` is now 0, so the `PC13` switch is
   out of the picture. Still unverified: the full pin table,
   `MICROPY_HW_UART_REPL PYB_UART_2` (claims an ST-LINK VCP the SC13048 does not have), and
   `UART3`/`I2C4` both mapped to `PB10`/`PB11`. PA15 is an SPI pin on other boards; the whole map
   is provisional and gets reworked deliberately later.
4. ~~**GC-heap cost of settrace is unmeasured.**~~ **MEASURED.** +10,908 bytes of flash and **no
   measurable GC heap cost at idle.** Settrace is enabled for its metadata and hook site only;
   the Python callback is never installed.
5. **Threads on SC20xxx: a design decision, not a tweak — settled 2026-09-03, see 12.3.** The stm32 port
   implements `_thread` with its own preemptive round-robin scheduler (`pybthread.c`) plus a
   GIL, so there is no parallelism on a single core -- it is a way to structure blocking code,
   and it taxes VM speed for all code and 4 KB of GC heap per thread. The call-stack walk is
   already per-thread (`MP_STATE_THREAD(current_code_state)`, linked in `vm.c`), so that part is
   free. What is missing is the **stop model**: the halt loop spins in one context, so other
   threads would keep running while stopped. Suspending the scheduler on halt, choosing
   all-stop versus per-thread-stop, and unpicking the single-global `mp_debug_hit_code_state`
   and handle table are firmware work that must be designed **before** SC20xxx firmware starts,
   not retrofitted. **Settled 2026-09-03 in 12.3** — all-stop with a single debug owner, which
   applies to SC20xxx too if it ever enables `MICROPY_PY_THREAD`.

### 11.5a Lab gotcha: a bad cable and a cheap hub look exactly like broken firmware

Learned expensively 2026-09-03. Three separate "the firmware is broken" symptoms during the rp2
work were all physical-layer faults, and each one sent the investigation at recently changed code.

**The signature.** Windows pops "USB device not recognized", and the device appears as
`Unknown USB Device (Device Descriptor Request Failed)` with **`VID_0000&PID_0002`** and
`ProblemCode 43`. A VID and PID of zero mean the device never answered `GET_DESCRIPTOR` on EP0 at
all. **Firmware that runs and then misbehaves cannot produce this** — it is a link that is not
carrying, or a device that is not powered.

Distinguish it from the two failures that *are* ours:

- Stale descriptor (11.5 item 2): the port still enumerates and reports OK, but every open fails.
- ST ROM bootloader (11.5 item 1): enumerates as `VID_0483`, not `VID_0000`.

**What happened.** First a bus-powered Terminus FE1.1s hub (`VID_1A40&PID_0101`) dropped its port
whenever both boards were attached and re-enumerating — plausibly a current-budget problem, since
each board's descriptor asks for 250 mA and such a hub has ~500 mA for everything. Then, with the
board moved to a root port, a **failing USB cable** produced the same signature intermittently,
and did so immediately after a firmware change, which made the change look guilty. It was not:
the disassembly of the suspect function was correct, and the same firmware passed every test once
the cable was replaced.

**The rule.** Before suspecting firmware, check `LocationInfo` and the parent device. If the
failing entry is `VID_0000` or sits on a hub, it is not the firmware. Keep boards on root ports
with known-good cables, and change one physical thing at a time. And when a change to working
firmware is suspected, **run `link_test` first** — seconds of work, and it answers what hours of
reading the diff cannot.

### 11.6 Why deploy costs what it costs (measured, 2026-09-02)

Two rounds of measurement on an SC13048, because the first diagnosis was wrong and the second
only half right. Recorded so nobody re-derives it.

**The transport was never the problem.** Ping round-trips in 1 ms. `File_Crc` reads and
checksums 8 KB in 11 ms. `File_List` answers in 1-3 ms. Everything slow is a write.

**Round 1 -- flushing per chunk.** `mp_debug_file_write()` called `storage_flush()` on every
~470-byte chunk. Fixed to flush once per file (protocol v5). Result: 2.3 -> 2.6 KB/s. **The
prediction of a large speedup was wrong**; the flush was real flash wear (4x) but not the
time.

**Round 2 -- open/close per chunk.** Each `File_Put` did a full open/write/close, and FatFs
closes by syncing the data sector *and* the directory entry, two different flash locations
that flashbdev's single cached erase unit cannot hold together. Measured ~140 ms per call
regardless of payload: a 64-byte chunk cost the same as a 470-byte one. Holding the handle
open across the transfer (protocol v6) took 8 KB from 3.0 s to 1.5 s.

**What remains, and why it is not worth chasing on SC13xxx.** Cost is now **~92 ms per
512-byte sector**, flat:

| Chunk size | Cost per chunk |
|---|---|
| 32 B | 1 ms |
| 128 B | 2 ms |
| 256 B | 92 ms |
| 470 B | 93 ms |

Writes are free until they complete a sector. The board explains it: `os.statvfs('/flash')`
reports `f_bsize = 512, f_frsize = 512` -- **one 512-byte cluster per sector**. Every 512 bytes
of data allocates a cluster and updates the FAT, which lives on a different flash page, so
flashbdev ping-pongs between the data page and the FAT page: two erase-and-program cycles per
sector. Corroborated by `File_Delete` costing 46 ms -- exactly one such cycle.

Three ways out, all rejected for this board:

- **Larger clusters.** The filesystem is 111 KB. At 4 KB clusters there would be 27 of them in
  total, and a project of small `.py` files would exhaust the volume in slack space.
- **littlefs.** Fixes it properly and is designed for flash, but the board exposes a FAT drive
  over MSC when the MODE pin is low. littlefs would take that away.
- **A two-page flashbdev cache.** Would work, costs ~2 KB RAM, but means patching upstream
  `flashbdev.c` for a cost paid only on a project's first deploy.

**Revisit on SC20xxx**, where a larger filesystem makes bigger clusters free and H7 flash
timing differs. Measure before changing anything.
---

### 11.7 Extension features added 2026-09-02

Beyond the debugger itself, all verified on hardware except where noted:

- **Commands:** Open Device Shell (live program output; Ctrl-C for a `>>>` prompt), Device
  Info, Erase Deployed Files, New Project, Select Device.
- **Ctrl+F5** runs without debugging. It still attaches, because device output is only
  forwarded to an attached session -- detaching would silence `print()`.
- **Zero-config F5.** `resolveDebugConfiguration` fills in a complete config, so a folder with
  a `.py` file needs no `launch.json`. The extension offers to write one after the first
  successful run, because otherwise VS Code asks which debugger every time -- and that list
  includes debuggers that will run the file on the PC instead of the board.
- **Packaging:** icon, marketplace metadata, and `build-extension.bat package` stamps the
  version into the filename (`micropython-sitcore-debug_v0.1.0.vsix`).

**Device console caveat, learned the hard way:** MicroPython runs `main.py` to completion
before starting the REPL (`ports/stm32/main.c:721`), so with a looping program there is no
`>>>` prompt and typing does nothing -- but `print()` output still flows, because stdout is
that port regardless. The terminal says so on connect. An earlier claim that the REPL is
"usable while stopped at a breakpoint" was wrong.

**Version string trap:** the firmware banner comes from `git describe`, and a fresh clone of
the fork had no `v1.29.0` tag (the fork's tags stop at v1.15), so the board reported
`MicroPython v1.15-6892`. Tag `v1.29.0` now exists at upstream commit `0fd6c573e` and is
pushed. If a clone ever reports the wrong version again, check the tags first.

## 12. Porting beyond SITCore

Revised 2026-09-03 — see decision 1. SC13xxx was the proof of concept; **ESP32, RP2040 /
RP2350 and SC20xxx (STM32H743) are the targets that matter**, all held to the same bar: F5 and
debug, with nothing for the user to configure or give up. First board for RP2 is the **Pico 2
(RP2350)**, which is on the desk and already builds a stock firmware (12.6).

**Feasibility, assessed 2026-09-03.** Nothing here is blocked, and three of the four groups
need only work that is already scoped:

| Target | Parity achievable | Gating work |
|---|---|---|
| **SC20xxx (STM32H743)** | Yes — cheapest of the three | Same `ports/stm32`. `MICROPY_HW_USB_CDC_NUM` is already upstream (`mpconfigboard_common.h:278`) and `usb.c:88` already arrays `usbd_cdc_itf[]` by it. Mostly board bring-up plus H7 storage differences. |
| **RP2040 / RP2350** | Yes | The `shared/tinyusb` second-CDC patch, plus the 12.3 stop model — which is exactly what removes any "don't use threads" rule. |
| **ESP32-S2** | Yes | **The same `shared/tinyusb` patch as RP2** — `ports/esp32/esp32_common.cmake:91-104` builds the same `shared/tinyusb/mp_usbd*.c` files. ESP32 sets `MICROPY_PY_THREAD_GIL (1)`, so holding the GIL through the halt *is* all-stop: none of 12.3's park handshake or lockout escalation applies. S2 is single-core, which makes it the simplest of the three. |

**Three boards, one per family — not board coverage.** Decided 2026-09-03: SC20xxx (H743),
Pico 2 (RP2350), and an **ESP32-S2**, each because it is the representative part for its family
and is on the desk. S3 and P4 are deliberately *not* in scope; neither are the ESP32 parts that
cannot carry a second CDC (12.7). The purpose is to show the extension working convincingly on
three different silicon families, not to enumerate boards. RP2040 follows RP2350 for free.

The order that follows: **SC20xxx first** (highest confidence, same port family), finish
**RP2/Pico 2** (its tinyusb patch pays for the S2 as well), then **ESP32-S2**.

### 12.1 What ports unchanged

`ports/stm32/mpdebug/` is written against `py/` APIs, not stm32 ones: the wire protocol,
breakpoint table, stepping, stack walk, locals and variable serialisation should all move as
they are. So should the three core hooks in `py/vm.c` / `py/mpconfig.h`, which are port-neutral
already. The whole host side (extension, DAP, `localNames.ts`) is unaffected.

### 12.2 What is stm32-specific and needs a per-port answer

Checked against the tree 2026-09-02; do not re-derive.

| Piece | stm32 today | rp2 |
|---|---|---|
| Second CDC | `MICROPY_HW_USB_CDC_NUM` (upstream) | `shared/tinyusb/tusb_config.h` derives `CFG_TUD_CDC` from the boolean `MICROPY_HW_USB_CDC`. Needs an `..._CDC_NUM` count instead — same name as stm32, so the patch is upstream-shaped. **One patch there serves rp2, esp32, samd, nrf, mimxrt, renesas-ra, alif.** Less work than it looks, and one trap; see below. |
| Halt before `main.py` | `MICROPY_BOARD_RUN_MAIN_PY` board hook | **No equivalent.** `ports/rp2/main.c:247` calls `pyexec_file_if_exists("main.py")` directly. Needs a hook, ideally shaped like stm32's so both ports share the design. |
| Flush filesystem | `storage_flush()` (FAT + flashbdev) | rp2 has `MICROPY_VFS_LFS2` **and** `MICROPY_VFS_FAT`. littlefs has different sync semantics; the per-chunk cost measured in 11.6 may not apply at all. Measure before assuming. |
| State across hard reset | RTC backup register | **Not the watchdog scratch registers** — `ports/rp2/machine_mem_backup.c` hands `scratch[0..3]`, `scratch[5..7]` and (RP2350) the powman scratch to user Python as `machine.mem_backup`, and `scratch[4]` belongs to pico-sdk. Claiming any of them would silently corrupt a documented feature, which decision 7 forbids. Use a magic-guarded word in `.uninitialized_data` via pico-sdk's `__uninitialized_ram()` (`pico/platform/sections.h:183`) — a `NOLOAD` section crt0 never clears, so it survives `watchdog_reboot()`. Its contents are undefined at cold boot, hence the magic word. |
| `MICROPY_PY_SYS_SETTRACE` | 1 in `mpconfigboard.h` | not set; needs enabling as on stm32. Cost was +10,908 bytes on L4 — trivial against RP2350's flash. |
| USB deinit before reset | `pyb_usb_dev_deinit()` | tinyusb equivalent needed, or the host keeps a stale device (section 9). |

**The second CDC, in detail (checked 2026-09-03).** Three things the table above cannot hold:

- **Half the scaffolding already exists.** `tusb_config.h` builds `_USBD_STR`, `_USBD_ITF` and
  `_USBD_EP` as enums keyed off the enabled classes, and `USBD_ITF_BUILTIN_MAX` /
  `USBD_EP_BUILTIN_MAX` are already arithmetic over them. `mp_usbd_cdc_poll_interfaces()` already
  loops `itf < 8`. So the patch is mostly turning `CFG_TUD_CDC ? 2 : 0` into a multiply and adding
  one `TUD_CDC_DESCRIPTOR` plus a string index per port — not writing a descriptor by hand.
- **There is a live bug that only fires at `CFG_TUD_CDC > 1`.** `mp_usbd_cdc.c:80-82` iterates
  `tud_cdc_n_available(itf)` but reads with `tud_cdc_read_char()` — the interface-0 variant. With
  one CDC it is correct by accident; with two, bytes arriving on CDC1 drain CDC0's FIFO. Fix it in
  the same patch, it is an upstream fix in its own right.
- **Raising the count alone gives a second REPL, not a debug channel.** Every CDC interface feeds
  `stdin_ringbuf` through `tud_cdc_rx_cb()`. The debug interface has to be excluded from stdio
  explicitly. This is the part with no scaffolding at all, and it is the real work in step 2.

**USB identity: keep stock VID/PID (`0x2E8A` / `0x0005`).** Decided 2026-09-03 under locked
decision 7 — every existing tool must recognise the board unchanged. The known risk is accepted:
Windows keys cached descriptors on VID/PID plus serial, so a machine that has already enumerated a
stock Pico 2 may need the device force-forgotten before it sees the second port. That is the same
class of failure as 11.5 item 2, so watch for it during bring-up rather than being surprised by it.
**Follow-up: SC13048's own USB identity should be revisited for the same reason** — deliberately
not touched now, it is not on the Pico 2 path.

### 12.3 The stop model — DECIDED 2026-09-03

**All-stop, with a single debug owner.** Decided from the tree, not from assumption; the facts
below are checked, do not re-derive them.

Locked decision 7 governs: our firmware is a drop-in for official MicroPython. So
`MICROPY_PY_THREAD` stays **1** on rp2 and esp32, `_thread` keeps behaving exactly as upstream,
and the debugger is what has to cope. Turning threads off in our own board config was
considered and rejected on that ground alone — a build where `import _thread` fails is a
variant you have to choose, not a MicroPython you can adopt.

**What the code says (checked 2026-09-03):**

| Fact | Where | Consequence |
|---|---|---|
| `MICROPY_PY_THREAD_GIL (0)` on rp2 | `ports/rp2/mpconfigport.h:142` | Genuine parallelism on two cores. There is no free stop and no GIL to hold. esp32 sets it to `1`, so the same model is nearly free there. |
| Exactly two threads, one per core | `core_state[2]`; `mp_thread_get_id() = get_core_num()+1` | On rp2 the thread set is fixed and tiny. Not so on esp32, where it is unbounded FreeRTOS tasks. |
| tinyusb's baremetal OSAL guards with `save_and_disable_interrupts()` | `shared/tinyusb/` | That disables **local-core** interrupts only, so tinyusb is **not SMP-safe**. The halt loop must not pump USB from whichever core happened to hit — which is exactly what `mp_debug_halt_loop()` does today. This is the constraint that shapes everything else. |
| `mutex_enter_blocking()` spins with no event hook | `ports/rp2/mpthreadport.h:56` | A core waiting on a `_thread.lock` never reaches a VM or event hook. So the obvious design — core 1 parks and hands its stop to core 0 to report — **deadlocks** whenever core 1 holds a lock core 0 wants. That is the commonest `_thread` bug there is, i.e. precisely the case someone attaches a debugger for. |
| `multicore_lockout_victim_init()` is called on **both** cores | `ports/rp2/mpthreadport.c:76,107` | Either core can freeze the other, and `ports/rp2/rp2_flash.c:171` already does this for flash writes. In-tree prior art, not a new mechanism, and the way out of the deadlock above. |

**The model:**

1. **All-stop.** Both cores stop. Per-thread-stop is unsound without a GIL: the still-running
   core mutates the objects the host is reading, and GC can run underneath the handle table.
2. **The core that hit owns the debug channel and runs the halt loop.** No handoff of stop
   ownership — the handoff is the thing that deadlocks.
3. **The other core is parked before the halt loop starts.** Cooperatively at its next VM or
   event hook, which leaves its Python stack intact and walkable and guarantees it is not inside
   tinyusb. If it does not arrive within a short timeout, escalate to
   `multicore_lockout_start_blocking()`. The escalation is what lets you *see* a core blocked on
   a lock rather than hanging with it.
4. **The escalation is guarded on the victim not being inside tinyusb** — `in_usbd_task`
   (`shared/tinyusb/mp_usbd_runtime.c:49`) plus our own flag around the debug pump. Freezing a
   core mid-`tud_task` and then driving tinyusb from the other one is the one reliable way to
   corrupt the transport.
5. **Every thread's stack and variables are readable.** `core_state[]` reaches the other
   thread's `current_code_state`, so the walk is already per-thread and costs nothing.
6. **`Value_Evaluate` and `Value_SetVariable` only in the pumping thread's frames.** Running
   Python in another thread's context from this core is not the same as reading its slots. The
   host greys the rest out rather than guessing — the same rule that governs locals in 11.0.

**esp32 later:** same model, different mechanism. Holding the GIL across the halt *is* all-stop,
bounded by each other task's next GIL acquisition. No lockout, no park handshake.

**SC13xxx does not change.** `MICROPY_PY_THREAD` is 0 there, so the model degenerates to what
already ships. The protocol gains a thread id that SC13xxx always reports as 1.

**Two assumptions to verify before writing the C** — neither is checked, the SDK is not vendored
in this tree: that pico-sdk's lockout victim handler spins with interrupts disabled, and that
`multicore_lockout_start_blocking()` nests safely with `rp2_flash.c`'s use of it during a
`File_Put`.

**Protocol and host impact.** `Execution_Stopped`, `Thread_Stack` and `Value_GetScope` gain a
thread id, and a `Thread_List` command is needed for DAP `threads`. On the host,
`debugSession.ts:524` hardcodes a single thread named `"main"`; stops report
`allThreadsStopped`. Implementation lands with the Pico 2 port — 12.4 — not before.


### 12.3a Measured on hardware 2026-09-03 — 12.3's premise was wrong

Before building the stop model, `test/threads_test.js` measured what actually happens on a
Pico 2 running a program with a `_thread` worker. **12.3 says "the halt loop spins in one
context, so other threads would keep running while stopped". That is not what happens.**

A counter incremented only by the worker thread did not move while the debugger was halted, and
the host received **two** stopped events:

```
[0] reason=0 (breakpoint)  line=16   <- core 0, step()
[1] reason=1 (pause)       line=11   <- core 1, worker()
```

**Why: the pause check is global.** `mp_debug_instr_tick()` opens with
`if (mp_debug_conditions & MP_DBG_COND_STOPPED)`, and `mp_debug_conditions` is one global. So the
moment core 0 halts and sets STOPPED, core 1 sees it at its next bytecode and halts as well.
**All-stop already happens** for any thread executing bytecode -- by accident, not by design.

That is good news: the work is not to build all-stop but to make the existing one coordinated.
What is actually broken, all demonstrated rather than predicted:

1. **The reported stack is the wrong thread's.** `mp_debug_hit_code_state` is a single global and
   the second core to halt overwrites it. Two runs of the same test gave
   `[step() at 16, <module>() at 23]` and `[worker() at 11]` for the identical stop --
   non-deterministic, and the host has no way to tell.
2. **Duplicate stop events.** The host is told the program stopped twice, once per thread. VS Code
   would show a stop at the breakpoint and then a second, unexplained one.
3. **Both cores run the halt loop, and both call `mp_usbd_task()`.** This is the tinyusb SMP
   hazard 12.3 warns about, reached by a different route than expected -- not one core pumping
   while another runs, but two cores pumping at once. Latent transport corruption.
4. **`Thread_List` reports 1** while two threads exist, so the host cannot even name them.
5. A thread blocked in a syscall rather than executing bytecode never reaches the check and so
   never stops -- the one case where 12.3's original description does hold.

**FIXED 2026-09-03, and verified on a Pico 2.** One thread owns a stop; the rest park
silently. `mp_debug_claim_halt()` does an atomic test-and-set of the owner inside
`MICROPY_BEGIN_ATOMIC_SECTION()` -- atomic because rp2 has no GIL and both cores reach it at
once -- and returns true as well when a thread re-enters its own halt, which the evaluation path
does. All four halt sites claim first: pause, step, breakpoint and uncaught exception. A thread
that loses the claim touches nothing at all: no stop event, no frame pointer, and above all it
never enters the pump, which is what had two cores inside tinyusb together.

| | before | after |
|---|---|---|
| stopped events per stop | **2** | **1** |
| stack reported | `[worker() at 11]` -- the wrong thread | `[step() at 16, <module>() at 23]` |
| other thread while halted | stopped | stopped |

Three runs, identical results -- the old behaviour was non-deterministic, so repetition is the
test. **Cost: +120 bytes on rp2, +112 on SC13048.** The whole hardware suite still passes on both.

Note what was **not** needed: no `multicore_lockout`, no park handshake. 12.3 assumed those
because it expected the other thread to keep running. It does not -- it halts on the same global
-- so the fix is about forty lines rather than the week 12.3 estimated.

**A real threaded, multi-file project works** -- verified on a Pico 2 by
`test/project_test.js`, which deploys `main.py`, a `worklib.py` beside it, and a
`helpers/mathy.py` in a subdirectory, with a worker thread running code from the subdirectory
module:

```
worklib.py:2 (main thread)          hit -> worklib.py:2 tick()  <-  main.py:19 <module>()
helpers/mathy.py:2 (worker thread)  hit -> helpers/mathy.py:2 scale()  <-  main.py:11 spin()
```

The second is the one that matters: **a breakpoint inside thread code hits, and the stack shows
the thread's own frames**, headed by its entry function. Breakpoints are not confined to the main
thread, and not confined to `main.py`.

**Still open: visibility, not correctness.** `Thread_List` reports 1, and the host cannot name or
select the second thread in VS Code's Threads panel. That needs a thread id in
`Execution_Stopped`, `Thread_Stack` and `Value_GetScope`, which is a protocol bump and host work.
A user debugging threaded code today gets correct answers about the thread that stopped, and no
way to look at the other one.

**Revised shape of the remaining work** (12.3's decisions -- all-stop, one debug owner, read-only
inspection of other threads -- all still stand):

- Elect one halt owner; the others park without sending an event or touching the handle table.
- Make `mp_debug_hit_code_state` per-thread, keyed off `core_state[]`.
- Only the owner pumps the transport. This removes the SMP hazard without needing
  `multicore_lockout` at all in the common case.
- Report real threads in `Thread_List`, and tag stop events with a thread id.

The park handshake and lockout escalation in 12.3 remain the answer for a thread that is **not**
executing bytecode; they are no longer needed for the common case, which is a considerably
smaller job than 12.3 assumed.

### 12.4 Order of work

Revised 2026-09-03 for the three-board scope in the section 12 intro.

0. ~~Decide the stop model.~~ **Done — see 12.3.**
0b. ~~Get a stock rp2 firmware building on Windows.~~ **Done — see 12.6.**

1. **`shared/tinyusb` second CDC.** **DONE — verified on a Pico 2, 2026-09-03.** `CFG_TUD_CDC` is now a count driven by
   `MICROPY_HW_USB_CDC_NUM` (the stm32 name, so the patch is upstream-shaped), with the second
   interface's string, interface, endpoint, descriptor and length entries alongside. Enabled on
   `RPI_PICO2/mpconfigboard.h` rather than in a separate debug board: under decision 7 a user
   must not have to choose a different firmware to get a debugger.

   **Cost: +392 bytes flash, +732 bytes RAM** (332,072 -> 332,464; 12,320 -> 13,052).

   Verified by decoding `mp_usbd_builtin_desc_cfg` out of the ELF: `totalLen=141`,
   `numInterfaces=4`, two IADs at interfaces 0 and 2, string indices 4 and 5, endpoints
   `0x81/0x02/0x82` and `0x83/0x04/0x84` with no duplicates, and the parse consuming exactly
   141 of 141 bytes — so the declared array length and the descriptor content agree, which is
   the usual failure of a hand-edited descriptor. What this does **not** prove is that a host
   enumerates both ports and passes data; that needs the board.

   **Confirmed on hardware.** The board enumerated `MI_00` (COM25, the REPL) and `MI_02`
   (COM26, the debug channel). Sending Python to CDC 1 produced nothing, so it is an independent
   stream and not a second REPL. Asserting DTR **and** RTS on CDC 1 did not reset the board, and
   CDC 0 kept answering normally — both fixes below hold in practice, not just in theory.

   **A third port, `MI_04`, appeared and is not ours** — and it is the best evidence the patch is
   right. The test board still had MicroPython Studio's files on it (12.5), whose `boot.py` calls
   `usb.device.get().init(cdc, builtin_driver=True)` to add a CDC from Python. Runtime interfaces
   are placed *after* the built-ins, starting at `USBD_ITF_BUILTIN_MAX`, and it landed at
   interface **4** — exactly where two built-in CDCs end. That constant is one of the things this
   patch changed from `(CFG_TUD_CDC ? 2 : 0)` to `(CFG_TUD_CDC * 2)`; unscaled, the runtime CDC
   would have collided at interface 2 and broken enumeration. Worth remembering that a board can
   carry leftovers that add USB interfaces, and that our port auto-detection must not assume the
   debug channel is simply "the second port".

   **The stale-descriptor risk accepted in 12.2 did not bite here.** Windows enumerated the new
   two-CDC topology cleanly at the unchanged `0x2E8A/0x0005` on this machine. One machine is not
   proof it never will, so keep it in mind on a fresh host.

   **Three bugs fixed in the same patch, each live only above one CDC, all upstream-worthy:**

   - `mp_usbd_cdc.c` looped over `tud_cdc_n_available(itf)` but read with `tud_cdc_read_char()`,
     the interface-0 variant — correct only by accident at `CFG_TUD_CDC == 1`.
   - Every CDC fed `stdin_ringbuf`, so a second interface became a second REPL and would eat the
     debugger's input. Stdio is now interface 0 only, matching how stm32 has always treated its
     extra CDCs.
   - **`tud_cdc_line_state_cb` fired the bootloader triggers for any interface.** Both
     `MICROPY_HW_USB_CDC_DTR_RTS_BOOTLOADER` (on by default on ESP32) and the 1200-baud touch
     acted regardless of which CDC saw the line-state change, and a debug host opening CDC 1
     asserts DTR/RTS as a matter of course. Left alone this would present as the board jumping
     into the bootloader whenever the debugger attached. Now scoped to interface 0. **Worth
     re-reading 11.5 item 1 with this in mind** — that unexplained SC13048 bootloader entry has
     the same shape, and stm32 has its own DTR handling worth checking the same way.
2. ~~**Halt before `main.py` on rp2.**~~ **DONE 2026-09-03.** Three macros with empty defaults
   in `py/mpconfig.h` — `MICROPY_BOARD_BEFORE_MAIN_PY`, `..._SKIP_MAIN_PY`, `..._AFTER_MAIN_PY`
   — called from `ports/rp2/main.c` around `pyexec_file_if_exists("main.py")`, right after
   `mp_usbd_init()` where USB is up and no user code has run. The board config points them at
   the engine's three phases. No `boardctrl` equivalent was needed, which is what the step 3
   split bought. The reboot flag lives in `.uninitialized_data` as planned; the tinyusb
   `pyb_usb_dev_deinit()` equivalent turned out to be actively harmful — see 12.8.
3. ~~**Move `mpdebug/` out of `ports/stm32/`.**~~ **DONE 2026-09-03, verified on SC13048.**
   The engine is `shared/mpdebug/` (wire protocol, mpdebug, break, files, vars, headers) plus
   `shared/mpdebug/mpdebug_port.h`, the ten-function port interface; stm32's implementation is
   `ports/stm32/mpdebug_port.c`. Wired through `SHARED_SRC_C`, the same convention as
   `shared/tinyusb` and `shared/runtime`, so another port adds five entries and one file.

   The last port-shaped piece was `mp_debug_run_main_py`, tied to stm32's `boardctrl`. Split
   into three port-neutral phases the engine owns — `mp_debug_before_main_py()`,
   `mp_debug_take_soft_reset()`, `mp_debug_after_main_py()` — which a port wraps in whatever
   hook it has. **This is what makes 12.4 step 2 tractable on rp2**: rather than inventing a
   `boardctrl` equivalent, rp2 calls those three around its own `pyexec_file_if_exists("main.py")`.

   **Total cost on SC13048: +176 bytes text** (358,420 -> 358,596), `.bss` -4. The move itself
   changed `.text` by zero bytes, which is the check to repeat if it is ever redone.
   `link_test` passes all ten checks. The 12.3 stop model still lands later — there is nothing
   to stop until a debugger runs on the target.

   **3a. Port shim extracted in place — done 2026-09-03, built, not yet hardware-verified.**
   Every stm32 dependency was confined to `mpdebug.c`; the other ~1,900 lines
   (`wireprotocol.c`, `mpdebug_break.c`, `mpdebug_files.c`, `mpdebug_vars.c`, headers) contain
   no port-specific symbol at all and will move untouched. The surface came to **ten functions**
   in `mpdebug/mpdebug_port.h`: five transport, one REPL byte for the halt loop's Ctrl-C escape
   hatch, two for the reset-surviving flag, plus storage flush and reset. stm32's
   implementation is `ports/stm32/mpdebug_port.c`, lifted verbatim.

   **Cost: +136 bytes text** (358,420 -> 358,556), `.bss` unchanged. Ten calls that used to be
   inlinable within one translation unit now cross a TU boundary and cannot be inlined without
   LTO. Accepted: 0.4% of the board's remaining headroom, and it is what makes every other port
   possible.

   **Verified on SC13048 hardware 2026-09-03**: `node test/link_test.js` passes all ten checks
   against the shim build — ping, `File_Put` with CRC match, reboot-into-halt across a USB
   re-enumeration, breakpoint at `main.py:11`, both stack frames named, step over and step in.
   Run that test after any change to the engine; it takes seconds and covers the whole transport.

   Deliberately sequenced this way — shim first, move second, rp2 third — so that SC13048 is
   never left broken and each step has its own measurable check.
4. ~~**Re-run the hardware tests** against the Pico 2.~~ **DONE 2026-09-03 — the whole suite
   passes on RP2350**, through a hub: `link_test` (10/10), `dap_sequence`, `deploy_speed`,
   `expand`, `busyloop`, `concurrent`. Details in 12.8. Original note:
   **`link_test` passes all ten checks on RP2350 as of 2026-09-03** — ping, `File_Put` with CRC match, reboot-into-halt across a USB
   re-enumeration, breakpoint at `main.py:11`, both frames named, step over and step in — and it
   passes through a USB hub. `dap_sequence`, `deploy_speed` and locals are still to run.

   Two host changes were needed. `protocol.ts` now carries a `KNOWN_DEVICES` table rather than
   one hardcoded VID/PID, matching the debug channel by **interface number** (always CDC 1), not
   enumeration order — a board can carry a third CDC from unrelated software, as ours did. And
   `link_test`'s program is now board-agnostic (no `pyb`), with its line numbers preserved
   because the assertions pin lines 6, 11 and 12.

   The reconnect after reboot was a single fixed 1.2 s wait and one attempt, tuned to SC13048.
   It now polls to a 15 s deadline: re-enumeration time varies by board, host controller and
   hub, and a fixed wait reports a slow enumeration as a dead board.
5. **SC20xxx (H743)** and **ESP32-S2** follow, reusing steps 1-4. SC20xxx skips step 1 entirely
   (`MICROPY_HW_USB_CDC_NUM` is already upstream on stm32); the S2 reuses the step 1 patch as-is.

**Do not carry the SC13xxx scarcity trade-offs over by reflex.** The bitwise CRC that saved 1 KB,
the 16-breakpoint cap and the 128-character path limit were all bought with a 34.8 KB flash
budget. The Pico 2 has ~690 KB free (12.6). The limits are `#ifndef`-guarded precisely so a
larger part can raise them.


### 12.5 Prior art: MicroPython Studio (niwantha33)

Examined 2026-09-02, source cloned to `Research/micropython-studio`. Same *category* — custom
firmware, breakpoints checked on-device, binary protocol over a second CDC — but a different
architecture, and the differences are the reason this project is still worth building.

| | Theirs | Ours |
|---|---|---|
| VS Code integration | **No `contributes.debuggers`.** F5, F10, F11 do nothing; stepping is buttons in a webview with single-letter keys | real debug adapter; F5/F10/F11, Variables, Watch, hover |
| Device-side footprint | 7 files, incl. a 16 KB `trace_pump.py` running on a `_thread`, and a `boot.py` that creates the second CDC from Python | none; debugger is in firmware |
| Start-up | user types `import trace_pump; trace_pump.start()` at the REPL, then launches their own program by hand | F5 |
| Wait-for-debugger | **none anywhere in their source** — hence the manual launch, and their sample's entry point is commented out | `STOP_ON_START` halts before the first bytecode |
| Breakpoint addressing | host runs `mpy_cross`, parses the `.mpy`, computes a bytecode offset; device does `__import__(module)` then `getattr` to find the function | `file:line`, resolved on the device |
| Variables | device formats a string with `repr()` (allocating on a halted program, truncated at 250 bytes); host regex-parses it back | binary records, fixed static buffer, no allocation |
| Call stack | manual button; frames named only where a breakpoint had been set, otherwise raw pointers | automatic on stop, every frame named |
| Boards | Pico, Pico W, Pico 2, Pico 2 W, ESP32-S3 | SC13048 (hence section 12) |

**Their one real advantage is board coverage**, which is what section 12 addresses. Their
`boot.py` trick — adding a CDC at runtime via MicroPython's `usb.device` module instead of
patching the USB descriptor — is worth remembering as a fallback if patching `shared/tinyusb`
turns out badly on some port.

**Not to be mentioned in any public text** (code comments, README, commit messages): see the
standing rule about comparative framing.

### 12.6 Building rp2 on Windows (the working recipe)

**Status 2026-09-03: a stock `RPI_PICO2` firmware builds.** Nothing of ours is in it yet — that
is the point of proving it first. Baseline to compare against once the debugger lands:

```
FLASH:  332,072 B / 1 MB    31.67%
RAM:     12,320 B / 512 KB   2.35%
firmware.uf2  665,088 bytes
```

Roughly 690 KB of flash free, against SC13048's 34.8 KB. **The scarcity that shaped most of the
SC13048 design does not exist on this part** — do not carry those trade-offs over by reflex.

pico-sdk is **2.3.0** at `lib/pico-sdk`. rp2 uses MicroPython's own `lib/tinyusb`
(`ports/rp2/CMakeLists.txt:17-18` sets `PICO_TINYUSB_PATH`), so pico-sdk's own submodules are not
needed. Submodules to init: `lib/pico-sdk` and `lib/mbedtls`.

**Prerequisites**, all verified absent before installing anything:

| Needed | Was | Why it is not optional |
|---|---|---|
| Host C/C++ compiler | **absent** — no `gcc`, `cc`, `clang`, `cl`, `g++` | `tools/Findpioasm.cmake` builds pioasm through `ExternalProject_Add` with no prebuilt path, so a host compiler is mandatory, not a convenience. Installed LLVM-MinGW (clang 22); `picotool` and `pioasm` both build with it. |
| `arm-none-eabi-gcc` | **8.3.1 (2019) on `PATH`**; two unused GNU Arm 10.x installs also present | 8.3.1 predates RP2350; pico-sdk 2.x wants GCC 10+ for Cortex-M33. Arm GNU Toolchain **12.2** installed via winget. |
| ninja | absent | Installed, though the build does not end up using it — see below. |
| cmake, python | 3.29.6, 3.14.0 | Fine as they are. |

**The new ARM toolchain must stay off the effective `PATH` ahead of 8.3.1.** Every flash figure in
section 11, including the 34.8 KB free that the SC13048 design rests on, was measured with 8.3.1,
and `build-firmware.bat:47` takes whatever `where arm-none-eabi-gcc` finds first. As installed this
is safe and it was checked, not assumed: winget put 12.2 on the **user** `PATH` while `C:\gcc\bin`
is on the **machine** `PATH`, and Windows concatenates machine first, so 8.3.1 still wins. The rp2
build prepends 12.2 for its own shell only. If SITCore ever builds with a different compiler, that
must be a deliberate, re-measured decision.

**`mpy-cross` comes from the PyPI wheel**, as in 11.2, exported as `MICROPY_MPYCROSS` — which
`py/mkrules.cmake:278` reads from the environment and then skips building it from source. Not
merely convenient: clang 22 **crashes** (frontend exit 70) compiling
`shared/runtime/gchelper_generic.c` for the host. The installed wheel is 1.29.0.post2 against a
v1.29.0 fork, so the bytecode version matches by construction. **If `MICROPY_MPYCROSS` is unset or
empty the build silently falls back to compiling mpy-cross and hits that crash** — check the
variable first if that error reappears.

**Use the `Unix Makefiles` generator, not Ninja.** `py/mkrules.cmake:154` builds
`qstrdefs.preprocessed.h` with a POSIX pipeline (`cat | sed | cc -E | sed > file`). Ninja runs
custom commands through `cmd.exe`, which cannot parse the quoting and fails with
``sed: unterminated `s' command``. Unix Makefiles uses `sh` and the pipeline works.

**Windows' 8,191-character command-line limit bites in three separate places** at this checkout
depth. Two need no patch:

- *Compile lines.* `C_INCLUDES` alone is 8,174 characters. Configure with
  `CMAKE_{C,CXX,ASM}_USE_RESPONSE_FILE_FOR_INCLUDES` and
  `CMAKE_{C,CXX}_USE_RESPONSE_FILE_FOR_OBJECTS` / `..._FOR_LIBRARIES` set to `ON`. Without them the
  truncation shows up as `unrecognized command-line option '-isyste'`.
- *The `sed` pipeline.* Solved by the generator choice above.

The third needed a fork patch, because MicroPython composes that command itself rather than letting
CMake manage it — see below.

**Fork patches carried (2 files, 36 lines, both upstream-submission candidates):**

- `py/mkrules.cmake` — the `qstr.i.last` rule put every QSTR source *and* the preprocessor flags on
  one command line: **28,346 characters here**. Now written to `qstr.sources.rsp` and
  `qstr.cppflags.rsp` via `file(GENERATE)` and passed as `@file`. Both had to move: ` sources ` did
  not begin until character 13,840, so relocating only the source list would still have overflowed.
- `py/makeqstrdefs.py` — `expand_response_files()` expands any `@file` argument to that file's
  lines, plus a guard that **raises instead of writing an empty `qstr.i.last`**. The silent version
  is what made this expensive: `preprocess()` computed `batch_size = 0`, wrote a 0-byte file and
  exited 0, and the build then failed three steps later with a bare `AssertionError` in
  `makemoduledefs.py` pointing nowhere near the cause.

This affects **every cmake-based port**, not just rp2. stm32 never hit it because it builds through
`py/mkrules.mk` instead.

### 12.7 Why ESP32-S2, and which ESP32 parts are out of scope

Assessed 2026-09-03. The mechanism below was read from the tree; the per-chip values come from
ESP-IDF's `soc_caps.h`, an external dependency **not** checked out here, so confirm the exact
part list against it before extending to another board.

**ESP32 is not one target.** Everything hangs off `ports/esp32/mpconfigport.h:268`:

```
#define MICROPY_HW_ENABLE_USBDEV  (SOC_USB_OTG_SUPPORTED)
```

| Group | USB device peripheral | Second CDC? |
|---|---|---|
| **S2, S3, P4** | USB OTG, driven by tinyusb | **Yes** — the same `shared/tinyusb` patch as RP2 |
| **C3, C6, H2, C5** | USB Serial/JTAG only | **No.** Fixed-function peripheral with its descriptor in silicon; not tinyusb, cannot gain an interface |
| **Classic ESP32, C2** | none | **No.** The "USB port" is an external CP2102/CH340 UART bridge — one UART, nothing to add to |

MicroPython enforces the middle row itself: `mpconfigport.h:329` is
`#error "Invalid build config: Can't enable both native USB and USB Serial/JTAG peripheral"`
when `SOC_USB_OTG_PERIPH_NUM <= 1`.

**S2 is the chosen part** — top row, so locked decision 5 holds unchanged, and it is single-core,
so with the GIL the stop model is the trivial case. S3 and P4 would also work and are simply not
in scope.

**The bottom two groups are out of scope, and that is the whole point of writing this down.**
They cannot carry a second CDC — that is silicon, not a software choice, and no firmware work
changes it. Serving them would need a **multiplexed single-pipe transport**, sharing one stream
between the debug protocol and the REPL. That is feasible: the wire protocol is already framed
with a 32-byte header, CRC-32 and a resync-capable receiver (`wireprotocol.c`), and resync is
exactly what sharing a stream with unframed REPL text needs. But it is a substantial new
component, **it is not being built**, and if those parts are ever wanted it deserves its own
decision rather than being absorbed into a port.

**Rejected outright: a TCP debug channel over Wi-Fi.** Section 5.3 treats the transport as a
swappable seam and TinyCLR has `PortDefinition_Tcp`, so it is cheap. But it needs credentials
configured before the first F5, which is precisely the kind of rule decision 1 forbids.

**One thing ESP32 gets free that RP2 did not.** Its PID is computed from a `CFG_TUD_*` bitmap
(`_PID_MAP`, `mpconfigport.h`), so adding a CDC yields a distinct PID automatically — the stale
Windows-descriptor risk accepted for RP2 in 12.2 does not arise.

### 12.8 What the rp2 port actually cost, and the three bugs that were not in the engine

**Milestone 2026-09-03: `link_test` passes all ten checks on a Pico 2 (RP2350), through a hub.**
Breakpoint, full named stack, step over and step in, on the same `shared/mpdebug/` engine
SC13048 runs — **the engine needed no change at all**. That is the result that matters for
SC20xxx and the ESP32-S2.

| | Stock | With debugger | Delta |
|---|---|---|---|
| FLASH | 332,072 | 354,672 | **+22,600** (2.2% of 1 MB) |
| RAM | 12,320 | ~18,700 | **+6,400** |

Of that, the second CDC is +392 flash / +732 RAM and the three VM hooks +1,952. Against ~670 KB
of flash still free, none of it matters here — unlike SC13048, where the same settrace alone ate
a third of the remaining budget.

**The whole hardware suite passes**, and two results are worth keeping:

| Test | Result on Pico 2 |
|---|---|
| `link_test` | 10/10 — transport, deploy, halt, breakpoint, stack, step over/in |
| `dap_sequence` | attach, capabilities, entry state, breakpoint at line 32, stack, globals |
| `deploy_speed` | **135.6 KB/s** (8 KB in 59 ms), CRC intact across a hard reset, abandoned transfer recovered |
| `expand` | containers, nesting, 40-child pagination, 128-char truncation |
| `busyloop` | reachable while spinning (ping 0-2 ms); VM hook 11,520 -> 813,568; pause of a spinning program works |
| `concurrent` | five pipelined requests in 3 ms |

**Deploy is ~25x faster than SC13048, and 11.6's diagnosis is confirmed.** That section measured
~92 ms per 512-byte sector on SC13048 -- 8 KB in 1.5 s, about 5.3 KB/s -- and traced it to a
512-byte cluster forcing a FAT-page rewrite for every sector, with the fix (larger clusters)
unavailable on a 111 KB volume. The Pico 2's littlefs uses 4096-byte blocks and the problem
simply is not there. **Do not port SC13048's deploy-speed workarounds.**

`busyloop` is the result that proves the port rather than the plumbing: the VM hook ran 802,048
times while a no-sleep loop spun, ping stayed under 2 ms, and pausing it worked. The
per-instruction hook is genuinely on the hot path and can interrupt a program that never yields.

**Everything that broke was in the 129-line port shim or the board config.** All three bugs are
invisible on stm32, and all three are the same mistake: assuming stm32's answer transfers.

1. **`tud_disconnect()` before the reset is harmful on rp2 — the exact inverse of stm32.**
   On stm32, `NVIC_SystemReset()` leaves the D+ pull-up asserted, so the host never sees a
   disconnect and keeps a stale device; `pyb_usb_dev_deinit()` is required (11.5 item 2). 12.2
   assumed rp2 needed an equivalent. It does not: `watchdog_reboot()` resets the USB block and
   releases the pull-up by itself, and a `tud_disconnect()` beforehand leaves it **deasserted
   across the reset**, so the host never sees the board come back at all. Proven by A/B against
   `machine.reset()` — the same `watchdog_reboot` call without the detach — which re-enumerates
   reliably on the same hub, cable and port where ours did not.

2. **A halt loop must pump tinyusb, and the pump must go in `mp_debug_port_link_up()`.**
   This is the deepest difference between the ports. On stm32, enumeration and transfers are
   interrupt-driven, so a loop that never unwinds still keeps USB alive. tinyusb does that work
   in `tud_task()`; its interrupt only queues events. The halt loop is by design a loop that
   never unwinds, so the shim has to drive the stack itself.

   Placement is not free choice: `mp_debug_pump()` returns early when `link_up()` is false, so
   that is the **only** place a pump is guaranteed to run. Putting it in `rx_avail()` — one level
   deeper, behind the failing check — deadlocks a board that halts before enumeration finishes:
   completing enumeration needs `tud_task()`, but `tud_task()` is only reached once enumerated.

3. **Three board hooks were missing, and `MICROPY_VM_HOOK_LOOP` is not the breakpoint hook.**
   `MICROPY_VM_HOOK_LOOP` runs only *after jump opcodes* — enough to keep the channel answerable
   and to halt at entry, which is why the port looked most of the way working. The
   per-instruction breakpoint check is `MICROPY_DEBUG_INSTR_HOOK`. Also missing were
   `MICROPY_DEBUG_STDOUT_HOOK` (so `print()` reaches the Debug Console) and
   `MICROPY_DEBUG_EXC_HOOK` (halt at an uncaught raise). **When porting, copy SC13048Q's whole
   debugger block rather than the hooks you remember.**

**The diagnostic lesson, which cost more than the bugs did.** Bugs 1 and 2 both present as the
board vanishing from USB with `VID_0000` / "Device Descriptor Request Failed" — the same
signature as the genuinely faulty hub and cable in 11.5a. Two real physical faults earlier the
same day made that explanation available every time, and it was wrong every time. `VID_0000`
means *attached but never answered*, which a firmware fault produces just as readily as a bad
cable. **Distinguish them by evidence, not plausibility**: check `LocationInfo` and the parent,
and A/B against a known-good path (`machine.reset()`) on the identical physical setup. The A/B
settled in one run what an afternoon of re-reading the diff did not.

**Hub support is a product requirement, not a nicety.** F5 does deploy -> reboot -> reconnect on
every run, so re-enumeration behaviour is a first-class user experience concern and hubs must be
in the test matrix. Note the board declares stock MicroPython's `USBD_MAX_POWER_MA (250)`,
untouched: a hub that cannot keep this board attached across a reset cannot keep stock
MicroPython attached either.

### 12.9 F5 works on the Pico 2 — and what only F5 could have found

**Verified 2026-09-03: F5 from VS Code deploys, halts, breakpoints, steps and prints on a
Pico 2**, the same as on SC13xxx. That is the product bar met on a second silicon family.

Everything before this drove the transport directly from `node test/*.js`, on Windows. Two
defects survived all of it, because no test exercised the path a real user takes:

1. **`MicroPython: New Project` wrote a `main.py` containing `import pyb`.** A user's very first
   F5 on a Pico 2 or ESP32 would fail — on a file the extension itself generated. The template is
   now board-neutral, as is `examples/blink/main.py`, which had the same problem and is what the
   sample instructions tell people to open.

2. **The Linux udev rule matched SITCore's VID/PID only.** On Linux a Pico 2 would hit both
   problems that file exists to solve: `/dev/ttyACM*` owned by `root:dialout` with the desktop
   user not in the group, and ModemManager sending AT commands at the debug channel for several
   seconds after plug-in. Both present as "the extension cannot find or open the board". Now one
   rule per board, with a note to keep it in step with `KNOWN_DEVICES` in `src/protocol.ts` —
   **a board the extension can find on Windows but cannot open on Linux is the same failure to
   the user, and harder to diagnose.**

Also corrected: user-facing messages said "No SITCore debug port found. The board must be in
VCP+VCP mode." VCP+VCP is SITCore's MODE-pin concept and means nothing on a Pico or ESP32.

**Left alone deliberately — a decision, not an oversight.** The extension is still
`micropython-sitcore-debug` / "MicroPython for SITCore", with `micropython-sitcore.*` command ids
and a "MicroPython SITCore" output channel. Renaming the extension id breaks existing installs
and marketplace identity, so it is a product decision, not a refactor. It needs making before
this ships supporting Pico 2 and ESP32-S2.

**The lesson for the remaining ports.** Both defects were in code no automated test touches and
that only a human pressing F5 on the target board would meet. When SC20xxx and the ESP32-S2 come
up, run F5 by hand on each before calling the port done — the hardware suite passing is necessary
and not sufficient.

### 12.10 Three rp2 boards, and what the second and third ones taught

**Done 2026-09-03: Pico (RP2040), Pico 2 (RP2350) and Adafruit QT Py RP2040 all deploy, halt,
breakpoint, step and print under F5.** The QT Py passed `link_test` 10/10 first try -- no new
firmware bugs from a second RP2040 board.

| Board | Chip | Firmware | Region | Used |
|---|---|---|---|---|
| Pico 2 | RP2350 | 354,800 | 1 MB | 33.8% |
| Pico | RP2040 | 365,844 | **640 KB** | **55.8%** |
| QT Py RP2040 | RP2040 | 363,612 | 1 MB | 34.7% |

**RP2040 firmware is ~11 KB larger than RP2350's** -- Cortex-M0+ lacks the compact Thumb-2
encodings the M33 has. **The plain Pico is the board to watch**: its 2 MB flash splits 1408 KB
filesystem / 640 KB firmware, leaving ~274 KB free. The QT Py runs the same chip with half the
pressure purely because it has 8 MB.

**The debugger config is no longer per board.** It lives in `ports/rp2/mpdebug_board.h`, included
once from `mpconfigport.h`, so every rp2 board gets the complete hook set; a board opts out with
`MICROPY_HW_MPDEBUG 0`. Copying ~45 lines into three board files is precisely how the missing
`MICROPY_DEBUG_INSTR_HOOK` happened (12.8), and three products make that mistake three times as
likely. Moving it rebuilt the Pico 2 byte-identical, which is the check to repeat if it is redone.

**A hook needs a call site, not just a definition -- this bit twice.** Each of these has three
parts: an empty default in `py/mpconfig.h`, a definition in the board or port config, and **a
call site in the port's own code**. Porting the first two and not the third leaves the macro
defined and never invoked, and it fails silently:

| Hook | Call site | Symptom when the call site is missing |
|---|---|---|
| `MICROPY_DEBUG_INSTR_HOOK` | `py/vm.c` (port-neutral) | halt and channel work; breakpoints never fire |
| `MICROPY_DEBUG_STDOUT_HOOK` | the port's `mp_hal_stdout_tx_strn` | everything works; `print()` never reaches the Debug Console |

**esp32 will need its own `MICROPY_DEBUG_STDOUT_HOOK` call site**, in its own stdout path. Check
it explicitly rather than assuming the board config is enough.

**Board USB identity is per board, not per chip family.** The QT Py overrides
`MICROPY_HW_USB_VID/PID` to Adafruit's `239a:80f8`; many rp2 boards do the same. Every one needs
an entry in `KNOWN_DEVICES` (`src/protocol.ts`) **and** a line in the udev rules, or the host
cannot find it -- on Windows or Linux.

**Two known gaps, neither a defect in the debugger:**

- **Two boards sharing a VID/PID cannot be told apart.** Pico and Pico 2 are both `2e8a:0005`, so
  with both attached `findPorts()` sees four matching ports and picks arbitrarily. Anyone with two
  Pi boards on the desk hits this. The fix is to group ports by their parent USB device rather
  than matching flat.
- **A stale extension install is invisible.** The version stays `0.1.0` across rebuilds, so
  `code --install-extension` silently skips unless given `--force`, and the resulting failure --
  "No debug port found" -- is indistinguishable from a hardware fault. It cost a diagnosis cycle
  here and would cost a customer a support ticket. Stamp a build id into the
  "extension 0.1.0 (built ...)" line the Debug Console already prints.

### 12.11 Building esp32 on Windows — seven obstacles, none of them the port

**Stock `ESP32_GENERIC_S2` builds as of 2026-09-03**: `micropython.bin` 1,441,952 bytes, 29% of
the app partition free. Getting there took seven fixes and **not one of them was in the
debugger** -- they were all in the Windows build environment. Recorded so nobody pays twice.

ESP-IDF **v5.4.0** at `~/esp/v5.4/esp-idf`. Build through `idf.py`, Ninja only.

| # | Symptom | Actual cause | Fix |
|---|---|---|---|
| 1 | "ESP-IDF Python virtual environment not found" | export derives the venv name from whichever Python runs it; system Python is 3.14, the venv is `idf5.4_py3.11_env` | set `IDF_PYTHON_ENV_PATH`, put 3.11 first on `PATH` |
| 2 | "The downloaded component espressif/tinyusb is corrupted" | MicroPython pulls tinyusb for s2/s3/p4 from a **git branch** and the manager hashes the checkout; Git for Windows sets `core.autocrlf=true` at **system** level, so every line ending is rewritten and the hash can never match | `git config --local core.autocrlf false` on the manager's cache repo (`%LOCALAPPDATA%/Espressif/ComponentManager/Cache/b_git_*`), then delete `managed_components` and `dependencies.lock` |
| 3 | `WinError 206` from `makeqstrdefs.py` | the script builds its own preprocessor command; IDF's include list alone passes 32767 characters | response file for the compiler invocation |
| 4 | `#include expects "FILENAME"`, `Wrong configuration file (ffconf.h)` | response files have their own quoting; `-DFFCONF_H="..."` lost its quotes | escape backslashes and quotes, wrap each argument |
| 5 | ``sed: unterminated `s' command`` | `mkrules.cmake` built `qstrdefs.preprocessed.h` with a POSIX pipeline; Ninja runs custom commands through `cmd.exe` | rewrote it as `makeqstrdefs.py qstrdefs` -- no cat, no sed, no shell |
| 6 | `Invalid value for '-G': 'Unix' is not 'Ninja'` | **ESP-IDF accepts no generator but Ninja**, so rp2's escape route does not exist here | see 5 -- the pipeline had to go |
| 7 | `WinError 206` again, in the new step | fixed the command length at one call site and not the other | one shared `command_with_response_file()` helper |

**Note the retry advice in obstacle 2 is actively wrong**: "please try running the command again"
can never succeed, because the checkout is deterministic. And **do not fix it by changing global
git config** -- that silently rewrites line endings for every other repository on the machine.

**The `py/` patch set is now five fixes, one story: make MicroPython's CMake build work on
Windows.** Response files for the qstr source list and flags (8191 limit); those files added to
`DEPENDS`, or a changed list is silently ignored; the leaked `multiprocessing` pool, harmless on
3.12 and fatal on 3.14; the preprocessor command via response file (32767 limit, unavoidable with
IDF); and qstrdefs without a shell. **All are upstream bugs, not fork-specific**, and the last one
matters most: it makes the build work under **Ninja on Windows**, the default generator for most
CMake users, which was simply broken before.

**Every one of these was verified not to change rp2's output** -- it rebuilt byte-identical
(354,800) after each change. That is the check to repeat when touching shared build code.

### 12.12 The ESP32-S2 boot loop — an IDF version mismatch, and how long it took to see

**Root cause, 2026-09-04: ESP-IDF 5.4.0 instead of the 5.5.2 MicroPython v1.29 pins against.**
Nothing to do with the debugger, the second CDC, `shared/tinyusb`, or the `py/` build patches.

`ports/esp32/lockfiles/dependencies.lock.<target>` pins the managed-component set, and
`CMakeLists.txt:66` points `DEPENDENCIES_LOCK` at it. That lockfile was resolved against **IDF
5.5.2**. Built on 5.4.0, the resulting component set links **both** `libdriver.a` (legacy I2C)
and `libesp_driver_i2c.a` (the new driver). IDF 5.4 ships a global constructor,
`check_i2c_driver_conflict` (`components/driver/i2c/i2c.c:1719`), that calls `abort()` when it
sees both -- **before `main()` runs**. The board boot-loops, never reaches MicroPython, and with
the console on UART it says nothing at all.

Note the README lists v5.4 among supported versions. It is not, at least for this lockfile:
trust `lockfiles/dependencies.lock.*` over the prose.

**Diagnosis, once there was a console:**

```
abort()
  check_i2c_driver_conflict   components/driver/i2c/i2c.c:1719
  do_global_ctors             components/esp_system/startup.c:104
  start_cpu0_default
```

**Getting a console is the whole story.** ESP32_GENERIC_S2 puts the IDF console on UART0, which
this board does not wire out, so a boot-looping app is indistinguishable from a dead one: no USB
device, no output, and unlike rp2 not even a `VID_0000` entry to inspect. One build with

```
CONFIG_ESP_CONSOLE_USB_CDC=y
CONFIG_ESP_CONSOLE_UART_DEFAULT=n
CONFIG_ESP_CONSOLE_SECONDARY_NONE=y
```

put the log on native USB and answered in one flash what a dozen flashes of hypothesis had not.
**Do this first on any board without a wired-out UART.**

**What the wasted cycles looked like, so they are not repeated:**

| Hypothesis | Test | Verdict |
|---|---|---|
| Two CDCs exhaust S2 endpoints | single-CDC build | wrong -- also failed |
| tinyusb driven before init | `tusb_inited()` guard | wrong -- also failed (guard kept; it is a real latent hazard on both rp2 and esp32) |
| Wrong board profile (UART REPL) | LOLIN_S2_MINI | wrong -- the official firmware *is* `ESP32_GENERIC_S2` and enumerates fine |
| PSRAM mismatch | `CONFIG_SPIRAM_IGNORE_NOTFOUND` is set | wrong -- absence is tolerated |
| Flash mode/size | header decode vs official | identical: DIO/80MHz/4MB |
| Our bootloader or partition table | our app on the official bootloader | wrong -- partition tables byte-identical, still failed |

**Two process failures, both mine.** First, I deleted `dependencies.lock` while chasing an
unrelated component-hash error, which let the manager rewrite the *pinned* lockfile -- the thing
that encodes which IDF version the component set belongs to. Second, the build printed
`Checking lockfile contents...` followed by the diff on **every single run**, and I never saw it
because I was filtering build output for `error:` and that line says `warning`.

**The rule: on a new port, get a console before writing a line of port code, and read the
warnings.** Compiling is not evidence that anything runs.

### 12.13 ESP32-S2 works — three silicon families on one engine

**2026-09-04: the full hardware suite passes on an ESP32-S2** (`ESP32_GENERIC_S2`, IDF 5.5.2):
`link_test` 10/10, `expand`, `busyloop`, `deploy_speed`, `concurrent`. **`shared/mpdebug` still
has not changed for any port** -- Cortex-M4, Cortex-M0+/M33 and Xtensa run the same engine.

| | Stock | With debugger | Delta |
|---|---|---|---|
| app image | 1,441,952 | 1,509,440 | **+67,488** (26% of the partition still free) |

Deploy throughput **24.2 KB/s** -- between SC13048's 5.3 and the Pico 2's 135.6.

**Two real port bugs, both the same shape, both invisible on stm32 and rp2.** esp32 rolls its own
idle loops for GIL and FreeRTOS reasons instead of funnelling through shared code, and **each one
is a place the debug channel goes deaf**:

| Idle path | Fix |
|---|---|
| `mp_hal_stdin_rx_chr` uses `MICROPY_EVENT_POLL_HOOK`, which esp32 defines itself and which never reaches `MICROPY_INTERNAL_EVENT_HOOK` | added the hook to both variants in `mpconfigport.h` |
| `mp_hal_delay_ms` has its **own** loop, bypassing `MICROPY_EVENT_POLL_HOOK` entirely | added the hook to that loop |

The second matters more than it looks: a typical program spends nearly all its life inside
`time.sleep()`, so without it the debugger is unreachable except in the microseconds between
sleeps. **This is why `link_test` passed while `expand`, `busyloop` and `concurrent` failed** --
`link_test` does its work while the board is *halted*, where the halt loop pumps directly; the
others attach to a *running* program.

**Full parity with RP2, verified 2026-09-04.** Beyond the five suite tests: multi-file
breakpoints (a module beside `main.py` and one in a subdirectory), a breakpoint **inside thread
code** reached only from a spawned thread, threading with one stop event and the correct stack,
`print()` forwarded to the Debug Console, halting at an uncaught exception (`reason=3` at the
raise point with the frame chain intact), and **F5 from VS Code**. Nothing on the RP2 list is
missing.

Still open, both product rather than correctness: the board is built as `ESP32_GENERIC_S2` rather
than a QT Py ESP32-S2 definition of its own (pin map, LED, USB identity), and the extension still
identifies itself as SITCore.

**The porting rule this establishes.** Three hooks need a **port-side call site**, and a missing
one always fails silently and differently:

| Hook | Call site | Symptom when missing |
|---|---|---|
| `MICROPY_DEBUG_INSTR_HOOK` | `py/vm.c` (port-neutral) | halt and channel work; breakpoints never fire |
| `MICROPY_DEBUG_STDOUT_HOOK` | the port's `mp_hal_stdout_tx_strn` | everything works; `print()` never reaches the Debug Console |
| `MICROPY_INTERNAL_EVENT_HOOK` | **every** idle loop the port owns | channel dead whenever no bytecode runs |

**On a new port, verify each of the three actually fires -- do not just check it is defined.**
Grep the port for its own idle loops (`mp_hal_delay_*`, `mp_hal_stdin_rx_chr`, any bespoke
`EVENT_POLL_HOOK`) and confirm the pump is reached from each.

