/**
 * Finding a board that is sitting in its bootloader.
 *
 * The user gesture is the same on every supported board -- hold BOOT (LDR on
 * SITCore) and tap RESET -- but what appears afterwards is not:
 *
 *   rp2      a mass-storage volume with INFO_UF2.TXT on it
 *   esp32    a serial port with Espressif's ROM VID/PID
 *
 * so both are polled and normalised into one DetectedBoot.
 */

import type { BootBoard, FlashKind } from "./boards";
import { SERIAL_BOOTLOADERS, familyForBoardId } from "./boards";
import { findUf2Drives, type Uf2Drive } from "./drives";

// serialport is loaded lazily for the same reason deviceLink.ts does it: it is
// a native module, and a load failure must surface from the command that needed
// it rather than break activation.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let serialportModule: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function serialport(): any {
    if (!serialportModule) {
        serialportModule = require("serialport");
    }
    return serialportModule;
}

export interface DetectedBoot {
    kind: FlashKind;
    /** Chip family, for messages: "RP2040", "RP2350", "ESP32-S2". */
    label: string;
    /**
     * Boards that could be this device.  More than one entry means the
     * bootloader does not identify the board and the user has to say which they
     * have -- an RP2040 in BOOTSEL is the case that forces this to be a list.
     */
    candidates: BootBoard[];
    /** Set when kind is "uf2-drive". */
    drive?: Uf2Drive;
    /** Set when kind is "esp-rom": the serial port path. */
    port?: string;
    /** USB identity of the bootloader device, when it has one. */
    vendorId?: number;
    productId?: number;
}

/** Every board currently sitting in a bootloader. Usually none. */
export async function detectBootloaders(): Promise<DetectedBoot[]> {
    const out: DetectedBoot[] = [];

    for (const drive of await findUf2Drives()) {
        const fam = familyForBoardId(drive.boardId);
        if (!fam) {
            // A UF2 drive we do not recognise: some other board entirely.  Skip
            // it rather than offer to write firmware onto it.
            continue;
        }
        out.push({
            kind: "uf2-drive",
            label: fam.label,
            candidates: fam.boards,
            drive,
        });
    }

    try {
        const ports = await serialport().SerialPort.list();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const p of ports as any[]) {
            const vid = parseInt(p.vendorId ?? "", 16);
            const pid = parseInt(p.productId ?? "", 16);
            const hit = SERIAL_BOOTLOADERS.find((s) => s.vid === vid && s.pid === pid);
            if (hit) {
                out.push({
                    kind: "esp-rom",
                    label: hit.board.name,
                    candidates: [hit.board],
                    port: p.path,
                    vendorId: vid,
                    productId: pid,
                });
            }
        }
    } catch {
        // No serialport module, or no permission to enumerate.  UF2 drives may
        // still have been found, so this is not fatal on its own.
    }

    return out;
}

/** Outcome of waiting for a board, so the caller can say what happened. */
export type WaitResult =
    | { kind: "found"; boards: DetectedBoot[] }
    | { kind: "cancelled" }
    | { kind: "timeout" };

/**
 * How long to keep watching for a board before giving up.
 *
 * The notification is cancellable, so this is not the user's only way out --
 * it exists so that a command left running unattended stops polling instead of
 * scanning drives and enumerating serial ports every half second forever.
 */
const WAIT_TIMEOUT_MS = 180_000;

/**
 * Poll until a board appears in a bootloader.
 *
 * Every board found is returned, not just the first: two boards in their
 * bootloaders at once is unusual but entirely possible on a bench, and picking
 * one silently would flash whichever happened to enumerate first.
 */
export async function waitForBootloader(
    isCancelled: () => boolean,
    timeoutMs = WAIT_TIMEOUT_MS,
    pollMs = 500,
): Promise<WaitResult> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        if (isCancelled()) {
            return { kind: "cancelled" };
        }
        const found = await detectBootloaders();
        if (found.length > 0) {
            return { kind: "found", boards: found };
        }
        if (Date.now() >= deadline) {
            return { kind: "timeout" };
        }
        await new Promise((r) => setTimeout(r, pollMs));
    }
}
