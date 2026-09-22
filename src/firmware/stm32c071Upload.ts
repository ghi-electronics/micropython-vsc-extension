// Copyright (c) GHI Electronics.
// SPDX-License-Identifier: MIT

/**
 * Upload a compiled .mpy to a GHI STM32C071 over its single USB CDC endpoint.
 *
 * Wire protocol (mirrors ghiboards/GHI_STM32C071/mpy_boot.c on the firmware
 * side):
 *
 *     host -> device: "MPY!" [len:u32 LE] [mpy bytes ... len]
 *     device -> host: "STM32C071 MPY loader ready\r\n"   greeting on boot
 *                     "ACK\r\n"       after magic received
 *                     "LEN OK\r\n"    after length validated (0 < len <= 10240)
 *                     "OK\r\n"        after flash write, immediately before reset
 *                     "ERR:<code>\r\n" on any failure; device does NOT reset
 *
 * The device runs its upload window at boot: 1 second when it already holds a
 * valid .mpy in flash, 30 seconds when flash is empty. On "OK" it calls
 * NVIC_SystemReset(); the CDC endpoint disappears from the host, then
 * re-enumerates after ~1-2 seconds and the debugger protocol takes over the
 * same CDC.
 */

import { KnownDevice } from "../protocol";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let serialportModule: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function serialport(): any {
    if (!serialportModule) {
        serialportModule = require("serialport");
    }
    return serialportModule;
}

/** Magic bytes the firmware waits for. Keep in sync with mpy_boot.c.
 * Deliberately "!MPY" (not "MPY!"): the leading '!' can never start a MPYDBG1
 * debugger frame, so if this ends up going to a running debugger by mistake
 * the frame decoder rejects it byte-by-byte rather than consuming 4 bytes and
 * corrupting a subsequent real frame. */
const MAGIC = Buffer.from("!MPY", "ascii");

/** How long to wait for the device to acknowledge, given it has just booted. */
const ACK_TIMEOUT_MS = 5_000;

/** How long to wait for the flash write to finish and the "OK" line to arrive. */
const OK_TIMEOUT_MS = 15_000;

export interface UploadResult {
    /** Bytes actually transmitted, including the 8-byte header. */
    bytesSent: number;
    /** Any diagnostic lines the device sent before "OK". */
    diagnostics: string[];
}

/**
 * Send `mpy` to the device on `port`, resolving when the firmware has replied
 * "OK" (meaning it is about to reset). The caller then closes the port and
 * waits for USB re-enumeration.
 *
 * Throws with the "ERR:<code>" line unaltered on a device-side failure; the
 * caller writes it into the Debug Console so a user hitting `ERR:len_range`
 * or `ERR:program` can see exactly what went wrong.
 */
export async function uploadMpy(
    port: string,
    mpy: Buffer,
    device: KnownDevice,
    log?: (s: string) => void,
): Promise<UploadResult> {
    const note = (s: string): void => { if (log) { log("[stm32c071] " + s); } };

    const max = device.mpyMaxBytes ?? 10240;
    if (mpy.length === 0) {
        throw new Error("compiled .mpy is empty");
    }
    if (mpy.length > max) {
        throw new Error(
            `user code too large for ${device.name}: `
            + `${mpy.length} bytes, but the board accepts at most ${max} bytes (10 KB).`);
    }
    if (mpy[0] !== 0x4d /* 'M' */) {
        // The firmware checks this and rejects with ERR:mpy_magic. Catching it
        // here saves a round trip and produces a clearer message.
        throw new Error(
            "compiled artifact does not start with 'M' -- mpy-cross may have failed silently.");
    }

    // Build the framed request in one buffer so it is delivered as a single
    // write; the firmware waits for exactly 4 magic bytes then 4 length bytes
    // and there is no reason to split them.
    const header = Buffer.alloc(8);
    MAGIC.copy(header, 0);
    header.writeUInt32LE(mpy.length, 4);
    const frame = Buffer.concat([header, mpy]);

    return new Promise<UploadResult>((resolve, reject) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let sp: any;
        let buffer = "";
        const diagnostics: string[] = [];
        let sawAck = false;
        let sawLenOk = false;
        let done = false;

        const finish = (err: Error | undefined, r?: UploadResult): void => {
            if (done) { return; }
            done = true;
            clearTimeout(ackTimer);
            clearTimeout(okTimer);
            try {
                if (sp?.isOpen) { sp.close(); }
            } catch { /* already gone */ }
            if (err) {
                reject(err);
            } else if (r) {
                resolve(r);
            }
        };

        // Two timers: one for the device to answer the magic at all, a longer
        // one for the flash write itself. Split so a device that got as far as
        // "ACK" but then stalled on flash still produces the correct diagnosis.
        const ackTimer = setTimeout(() => {
            finish(new Error(
                `${device.name}: no acknowledgement within ${ACK_TIMEOUT_MS} ms.\n`
                + `The boot upload window is short (~1 s when flash already holds a .mpy). `
                + `Tap RESET on the board and press F5 again.`));
        }, ACK_TIMEOUT_MS);

        const okTimer = setTimeout(() => {
            finish(new Error(
                `${device.name}: device accepted the upload but did not confirm within `
                + `${OK_TIMEOUT_MS / 1000} s. It may be stuck mid-flash; power-cycle and retry.`));
        }, OK_TIMEOUT_MS);

        const processBuffer = (): void => {
            for (;;) {
                const nl = buffer.indexOf("\n");
                if (nl < 0) { return; }
                const line = buffer.slice(0, nl).replace(/\r$/, "");
                buffer = buffer.slice(nl + 1);
                if (line.length === 0) { continue; }
                note("<- " + line);
                diagnostics.push(line);

                if (line.startsWith("ERR:")) {
                    finish(new Error(`${device.name}: device rejected upload (${line}).`));
                    return;
                }
                if (line === "ACK") {
                    sawAck = true;
                    continue;
                }
                if (line === "LEN OK") {
                    sawLenOk = true;
                    continue;
                }
                if (line === "OK") {
                    if (!sawAck || !sawLenOk) {
                        finish(new Error(
                            `${device.name}: unexpected "OK" without ACK/LEN OK first `
                            + `-- protocol out of sync.`));
                        return;
                    }
                    finish(undefined, { bytesSent: frame.length, diagnostics });
                    return;
                }
                // The greeting line ("STM32C071 MPY loader ready") and any
                // stale bytes from a previous boot land here; ignored.
            }
        };

        try {
            sp = new (serialport().SerialPort)(
                { path: port, baudRate: 115200 },
                (err: Error | null | undefined) => {
                    if (err) {
                        finish(new Error(
                            `${device.name}: could not open ${port}: ${err.message}`));
                        return;
                    }
                    // A short pause lets the greeting arrive (best effort;
                    // stale bytes from a previous boot may be interleaved,
                    // which the parser above tolerates).
                    setTimeout(() => {
                        if (done) { return; }
                        note(`-> MPY! + ${mpy.length} bytes`);
                        try {
                            sp.write(frame, (werr: Error | null | undefined) => {
                                if (werr) {
                                    finish(new Error(`${device.name}: write failed: ${werr.message}`));
                                }
                            });
                        } catch (e) {
                            finish(e as Error);
                        }
                    }, 200);
                });
            sp.on("data", (d: Buffer) => {
                buffer += d.toString("utf8");
                processBuffer();
            });
            sp.on("error", (e: Error) => {
                // A port that closes under us during the upload window is
                // usually the device rebooting -- which only happens on "OK",
                // and would have been finish()ed already. Anything else is a
                // real failure.
                if (!done) { finish(new Error(`${device.name}: ${e.message}`)); }
            });
            sp.on("close", () => {
                if (!done) {
                    finish(new Error(
                        `${device.name}: port closed before the device confirmed the upload.`));
                }
            });
        } catch (e) {
            finish(e as Error);
        }
    });
}

/**
 * Wait for the STM32C071's CDC endpoint to reappear after NVIC_SystemReset().
 *
 * On success returns the port path; on timeout throws. Windows tends to
 * re-issue the same COM number when VID/PID/serial match, but the API is
 * enumeration-based so this does not depend on that.
 */
export async function waitForDevice(
    device: KnownDevice,
    timeoutMs = 15_000,
    pollMs = 400,
    findPort?: () => Promise<string | undefined>,
): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    // Default finder: enumerate serial ports and match VID/PID.
    const finder = findPort ?? (async () => {
        try {
            const ports = await serialport().SerialPort.list();
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            for (const p of ports as any[]) {
                const vid = parseInt(p.vendorId ?? "", 16);
                const pid = parseInt(p.productId ?? "", 16);
                if (vid === device.vid && pid === device.pid) {
                    return p.path as string;
                }
            }
        } catch { /* enumeration failed; try again next poll */ }
        return undefined;
    });

    while (Date.now() < deadline) {
        const path = await finder();
        if (path) {
            return path;
        }
        await new Promise((r) => setTimeout(r, pollMs));
    }
    throw new Error(
        `${device.name}: port did not reappear within ${timeoutMs / 1000} s of the upload. `
        + `Check the USB cable, or unplug and replug the board.`);
}
