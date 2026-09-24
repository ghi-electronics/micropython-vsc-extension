// Copyright (c) GHI Electronics.
// SPDX-License-Identifier: MIT

/**
 * Wire protocol constants for the MicroPython debug engine.
 *
 * These mirror shared/mpdebug/micropython_debugging.h in the firmware.
 * Any change here must be made there too -- the two are a single contract.
 * The framing derives from the .NET Micro Framework debug protocol.
 */

/** 7 characters plus NUL, stuffed into 8 bytes. */
export const MARKER = Buffer.from("MPYDBG1\0", "binary");
export const HEADER_SIZE = 32;

/** WP_Flags */
export const FLAG_NON_CRITICAL = 0x0001;
export const FLAG_REPLY = 0x0002;
export const FLAG_NACK = 0x4000;
export const FLAG_ACK = 0x8000;

/** Commands. Device-to-host events are marked. */
export const enum Cmd {
    MonitorPing = 0x00000000,
    /** device -> host event: program stdout */
    MonitorOutput = 0x00000001,
    MonitorReboot = 0x00000007,
    /**
     * Ask the port to leave the running firmware and reboot into its ROM
     * update loader (STM32 ROM DFU on GHI STM32C071). Ports without a DFU
     * path keep the weak-default no-op on the device side; this command
     * therefore only makes sense on boards whose manifest kind is "stm32-dfu".
     */
    MonitorEnterDfu = 0x00000008,

    ExecutionStep = 0x00020003,
    ExecutionCapabilities = 0x00020008,
    ExecutionBreakpoints = 0x00020005,
    /** device -> host event */
    ExecutionStopped = 0x00020006,
    ExecutionChangeConditions = 0x00020001,

    ThreadList = 0x00020010,
    ThreadStack = 0x00020011,
    ValueGetScope = 0x00020030,
    ValueEvaluate = 0x00020031,
    ValueGetChildren = 0x00020032,
    ValueSetVariable = 0x00020033,

    FilePut = 0x00030000,
    FileCrc = 0x00030001,
    FileDelete = 0x00030002,
    FileMkdir = 0x00030003,
    FileList = 0x00030004,
    /** Filesystem size, so a deploy can fail before it starts rather than part-way. */
    FileStat = 0x00030005,
}

/** Debugger state bits, as understood by Execution_ChangeConditions. */
export const enum Cond {
    /** The VM is halted; the halt loop pumps the channel and does not unwind. */
    Stopped = 0x00000001,
    /** Halt before the first bytecode of main.py on the next reset. */
    StopOnStart = 0x00000002,
    /**
     * A debug session is attached. Keeps the VM hook live with no breakpoints
     * set, which is what pause and stepping require.
     */
    Attached = 0x00000004,
}

/** Why the VM stopped. Maps onto DAP's `stopped` event reason. */
export const enum StopReason {
    Breakpoint = 0,
    Pause = 1,
    Step = 2,
    Exception = 3,
    Entry = 4,
    Exited = 5,
}

export const STOP_REASON_TO_DAP: Record<number, string> = {
    [StopReason.Breakpoint]: "breakpoint",
    [StopReason.Pause]: "pause",
    [StopReason.Step]: "step",
    [StopReason.Exception]: "exception",
    [StopReason.Entry]: "entry",
};

export const enum Scope {
    Locals = 0,
    Globals = 1,
}

export const enum StepMode {
    None = 0,
    In = 1,
    Over = 2,
    Out = 3,
}

export const enum RebootFlag {
    Soft = 0x00000000,
    WaitForDebugger = 0x00000001,
    Hard = 0x00000002,
}

export const enum FileFlag {
    First = 0x00000001,
    Last = 0x00000002,
}

export const FILE_ERR_FAILED = -1;
export const FILE_ERR_NOT_FOUND = -2;
export const FILE_ERR_BAD_REQUEST = -3;

/**
 * Largest payload the device will accept (WP_MAX_PAYLOAD in wireprotocol.h).
 * File_Put chunks are sized against this.
 */
export const MAX_PAYLOAD = 512;

/**
 * Boards we know how to talk to.
 *
 * Most entries present the debug protocol on their second CDC function, so
 * IFACE_DEBUG below picks out the right port on a two-CDC device. Note the
 * Pico deliberately keeps stock MicroPython's VID/PID: a board running stock
 * firmware therefore matches here too, but exposes only one CDC, so findPorts()
 * finds a REPL and no debug channel -- which is the correct answer for it.
 *
 * `singleCdc` marks a board that presents a single CDC endpoint carrying both
 * the boot-time .mpy upload window and, after reset, the debug protocol.
 * The STM32C071 is that shape: no filesystem, no REPL, one interface used
 * sequentially for two purposes. findPorts() treats a single-CDC board's port
 * as the debug port; the launch flow uploads the compiled .mpy over that
 * same port before attaching the debug protocol.
 *
 * VID/PID is only used to locate the port and identify a supported device
 * class; the update check uses MICROPY_HW_BOARD_NAME (from the manifest) to
 * decide which release group the running firmware belongs to. A board whose
 * USB identity is not listed here can still be debugged by pinning debugPort
 * in launch.json -- see the ChromeOS section of the README for the pattern.
 */
export interface KnownDevice {
    vid: number;
    pid: number;
    name: string;
    /**
     * True when this device presents a single CDC endpoint, used first for
     * an .mpy upload handshake at boot and then for the debug protocol.
     * F5 compiles the entry script with mpy-cross, uploads via the MPY!
     * wire protocol, waits for the board to reset, and reconnects.
     */
    singleCdc?: boolean;
    /**
     * mpy-cross target architecture flag for a single-CDC board.
     * Passed as `-march=<arch>`. Ignored for boards that hold their own
     * runtime compiler.
     */
    mpyArch?: string;
    /**
     * Maximum size in bytes of the .mpy the board will accept. The upload
     * is refused past this and the error surfaces before anything is written.
     */
    mpyMaxBytes?: number;
}
export const KNOWN_DEVICES: KnownDevice[] = [
    { vid: 0x2e8a, pid: 0x0005, name: "Raspberry Pi Pico / Pico 2" },
    // esp32 computes its PID from a CFG_TUD_* bitmap, so two CDCs yields 0x4002
    // where stock (one CDC) is 0x4001 -- a distinct identity for free.
    { vid: 0x303a, pid: 0x4002, name: "ESP32-S2 / S3" },
    // STM32C071: single CDC, MPY! upload window at boot, then debug protocol.
    // 10 KB is the reserved flash region for the .mpy in ghiboards/GHI_STM32C071.
    // PID sits after 0xF300 (DueLink) and 0xF301 (Microblock) in GHI's PID space.
    {
        vid: 0x1b9f, pid: 0xf302, name: "GHI STM32C071 Debug",
        singleCdc: true, mpyArch: "armv6m", mpyMaxBytes: 10240,
    },
];

/**
 * Composite interface numbers. CDC0 (interface 0) is the REPL; CDC1
 * (interface 2) carries the debug protocol.
 */
export const IFACE_REPL = 0;
export const IFACE_DEBUG = 2;
