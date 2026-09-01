/**
 * Wire protocol constants for the MicroPython debug engine.
 *
 * These mirror ports/stm32/mpdebug/micropython_debugging.h in the firmware.
 * Any change here must be made there too -- the two are a single contract.
 */

/** 7 characters plus NUL, stuffed into 8 bytes. */
export const MARKER = Buffer.from("GHIPKT1\0", "binary");
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

    FilePut = 0x00030000,
    FileCrc = 0x00030001,
    FileDelete = 0x00030002,
    FileMkdir = 0x00030003,
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

/** USB identity of a SITCore board running this firmware, in VCP+VCP mode. */
export const USB_VID = 0x1b9f;
export const USB_PID_CDC2 = 0xf105;

/**
 * Composite interface numbers. CDC0 (interface 0) is the REPL; CDC1
 * (interface 2) carries the debug protocol.
 */
export const IFACE_REPL = 0;
export const IFACE_DEBUG = 2;
