// Copyright (c) GHI Electronics.
// SPDX-License-Identifier: MIT

/**
 * Upload a multi-module bytecode bundle to a GHI STM32C071 over its single
 * USB CDC endpoint.
 *
 * Wire protocol (mirrors ghiboards/GHI_STM32C071/mpy_boot.c on the firmware
 * side):
 *
 *     host -> device: "!MPZ" [len:u32 LE] [bundle bytes ... len]
 *     device -> host: "STM32C071 MPY loader ready\r\n"   greeting on boot
 *                     "ACK\r\n"       after magic received
 *                     "LEN OK\r\n"    after length validated (0 < len <= 10240)
 *                     "OK\r\n"        after flash write, immediately before reset
 *                     "ERR:<code>\r\n" on any failure; device does NOT reset
 *
 * The device runs its upload window at boot: 3 seconds when it already
 * holds a valid bundle in flash, 30 seconds when flash is empty.  On "OK"
 * it calls NVIC_SystemReset(); the CDC endpoint disappears from the host,
 * then re-enumerates after ~1-2 seconds and the debugger protocol takes
 * over the same CDC.
 *
 * Bundle layout (little-endian; must match mpy_flash_importer.c on device):
 *
 *     +0    "MPMH"                 magic (4 bytes)
 *     +4    count                  u16 -- number of modules
 *     +6    reserved               u16 (zero)
 *     +8    module 0 header + payload
 *           ...
 *
 *   Each module (4-byte aligned):
 *
 *     +0    name_len               u16
 *     +2    reserved               u16 (zero)
 *     +4    mpy_len                u32
 *     +8    name bytes             name_len bytes, no NUL
 *     +8+alignedN  mpy bytes       mpy_len bytes
 *
 * The entry script (whatever `program` in the launch config points at) is
 * packed as the module named "main".  Every other `.py` file in the same
 * directory is packed under its stem (`ssd1306.py` -> "ssd1306"), so user
 * code can `import ssd1306` and the on-device importer will find it.
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

/** Wire-frame magic; leading '!' guarantees a mis-directed upload cannot
 * confuse a running debugger's MPYDBG1 frame decoder. */
const WIRE_MAGIC = Buffer.from("!MPZ", "ascii");
/** Bundle-in-flash magic (start of payload bytes). */
const BUNDLE_MAGIC = Buffer.from("MPMH", "ascii");

/** How long to wait for the device to acknowledge, given it has just booted. */
const ACK_TIMEOUT_MS = 5_000;

/** How long to wait for the flash write to finish and the "OK" line to arrive. */
const OK_TIMEOUT_MS = 15_000;

export interface BundleModule {
    /** Module name as it appears in Python `import`.  The entry module must
     * be named exactly "main". */
    name: string;
    /** Bytecode as emitted by mpy-cross. */
    mpy: Buffer;
}

export interface UploadResult {
    /** Bytes actually transmitted, including the 8-byte wire header. */
    bytesSent: number;
    /** Any diagnostic lines the device sent before "OK". */
    diagnostics: string[];
}

/** Round `n` up to the next multiple of 4.  Names and mpy payloads are
 * 4-byte aligned inside the bundle so the u32 length fields of subsequent
 * modules stay aligned when the flash is read in place on STM32C0. */
function align4(n: number): number {
    return (n + 3) & ~3;
}

/**
 * Build the flash-format bundle from a list of modules.  This is what gets
 * programmed to the reserved 10 KB region on device.
 *
 * Enforces the 63-char name limit (matching MP_DBG_FILE_MATCH_MAX on the
 * board, and the firmware's practical assumption); anything longer would
 * still upload but the debugger wouldn't be able to set breakpoints in it.
 */
export function buildBundle(modules: BundleModule[]): Buffer {
    if (modules.length === 0) {
        throw new Error("empty module list");
    }
    if (modules.length > 65535) {
        throw new Error(`too many modules (${modules.length}); u16 count limit`);
    }
    for (const m of modules) {
        if (!m.name || m.name.length === 0) {
            throw new Error("module with empty name");
        }
        if (m.name.length > 63) {
            throw new Error(
                `module name '${m.name}' is ${m.name.length} chars; on-device breakpoint `
                + `matching caps at 63.  Rename or shorten a directory in its path.`);
        }
        if (m.mpy.length === 0) {
            throw new Error(`module '${m.name}' has empty .mpy`);
        }
        if (m.mpy[0] !== 0x4d /* 'M' */) {
            throw new Error(
                `module '${m.name}' .mpy does not start with 'M' -- mpy-cross may have failed silently.`);
        }
    }
    // Compute total size to allocate once.
    let total = 8;  // "MPMH" + count + reserved
    for (const m of modules) {
        total += 8;                          // module header
        total += align4(Buffer.byteLength(m.name, "utf8"));
        total += align4(m.mpy.length);
    }
    const buf = Buffer.alloc(total);
    let off = 0;
    BUNDLE_MAGIC.copy(buf, off); off += 4;
    buf.writeUInt16LE(modules.length, off); off += 2;
    buf.writeUInt16LE(0, off);              off += 2;  // reserved
    for (const m of modules) {
        const nameBytes = Buffer.from(m.name, "utf8");
        buf.writeUInt16LE(nameBytes.length, off); off += 2;
        buf.writeUInt16LE(0, off);                off += 2;  // reserved
        buf.writeUInt32LE(m.mpy.length, off);     off += 4;
        nameBytes.copy(buf, off);                 off += align4(nameBytes.length);
        m.mpy.copy(buf, off);                     off += align4(m.mpy.length);
    }
    // Sanity: we should have written exactly `total`.
    if (off !== total) {
        throw new Error(`bundle build accounting error: wrote ${off}, expected ${total}`);
    }
    return buf;
}

/**
 * Send `modules` to the device on `port`, resolving when the firmware has
 * replied "OK" (meaning it is about to reset).  The caller then closes the
 * port and waits for USB re-enumeration.
 *
 * Throws with the "ERR:<code>" line unaltered on a device-side failure;
 * the caller writes it into the Debug Console so a user hitting
 * `ERR:len_range` or `ERR:program` can see exactly what went wrong.
 */
export async function uploadBundle(
    port: string,
    modules: BundleModule[],
    device: KnownDevice,
    log?: (s: string) => void,
): Promise<UploadResult> {
    const note = (s: string): void => { if (log) { log("[stm32c071] " + s); } };

    const max = device.mpyMaxBytes ?? 10240;
    const bundle = buildBundle(modules);
    if (bundle.length > max) {
        // Point at the largest module first so the user knows what to trim.
        const biggest = [...modules].sort((a, b) => b.mpy.length - a.mpy.length)[0];
        throw new Error(
            `bundle too large for ${device.name}: ${bundle.length} bytes, but the board `
            + `accepts at most ${max} bytes (10 KB).  Biggest module: '${biggest.name}' `
            + `at ${biggest.mpy.length} bytes.`);
    }

    // Build the framed request in one buffer so it is delivered as a single
    // write; the firmware waits for exactly 4 magic bytes then 4 length bytes.
    const header = Buffer.alloc(8);
    WIRE_MAGIC.copy(header, 0);
    header.writeUInt32LE(bundle.length, 4);
    const frame = Buffer.concat([header, bundle]);

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
                + `The boot upload window is short (~3 s when flash already holds a bundle). `
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
                        note(`-> !MPZ + ${bundle.length} bytes (${modules.length} modules: `
                            + modules.map(m => `${m.name}=${m.mpy.length}B`).join(", ") + ")");
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
