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
    /**
     * The USB identity alone does not prove this board is in its bootloader,
     * so it must be asked before being offered to the user. See
     * SERIAL_BOOTLOADERS in boards.ts.
     */
    ambiguous?: boolean;
}

/** Identity of a detected device, stable across polls. */
function keyOf(b: DetectedBoot): string {
    return b.kind === "uf2-drive" ? `drive:${b.drive?.mount}` : `port:${b.port}`;
}

/** Every board currently sitting in a bootloader. Usually none. */
export async function detectBootloaders(): Promise<DetectedBoot[]> {
    const out: DetectedBoot[] = [];

    for (const drive of await findUf2Drives()) {
        const fam = familyForBoardId(drive.boardId);
        // A drive we do not recognise is still reported, with no candidates.
        //
        // INFO_UF2.TXT is proof that a UF2 bootloader is present, even when the
        // Board-ID means nothing to this build -- a board released after it, or
        // one we simply do not carry firmware for.  Dropping it here produced
        // the worst possible answer, "no board found", while the board sat in
        // its bootloader in plain sight.  The caller offers the published list
        // instead and lets the user say which board it is.
        out.push({
            kind: "uf2-drive",
            label: fam ? fam.label : (drive.model ?? drive.boardId),
            candidates: fam ? fam.boards : [],
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
                    ambiguous: hit.ambiguous,
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
 * How long before an ambiguous device that did not answer is asked again.
 *
 * Long enough that a board which is simply running is not interrogated
 * constantly, short enough that pressing BOOT and RESET is noticed promptly.
 */
const RECHECK_MS = 8_000;

/**
 * Poll until a board appears in a bootloader.
 *
 * Every board found is returned, not just the first: two boards in their
 * bootloaders at once is unusual but entirely possible on a bench, and picking
 * one silently would flash whichever happened to enumerate first.
 */
export async function waitForBootloader(
    isCancelled: () => boolean,
    verify?: (board: DetectedBoot) => Promise<boolean>,
    timeoutMs = WAIT_TIMEOUT_MS,
    pollMs = 500,
): Promise<WaitResult> {
    const deadline = Date.now() + timeoutMs;

    // Ambiguous devices already asked, and found not to be in a bootloader,
    // with when they were asked.
    //
    // Two things clear an entry.  Its device disappearing is the quick one --
    // that is what tapping RESET does.  But the board re-enumerates in well
    // under one poll interval, so that gap is usually never observed, and
    // relying on it alone left the prompt waiting for a board that was sitting
    // right there in its bootloader.  So an entry also expires on a timer.
    // The timer is what makes this correct; the disappearance check only makes
    // it quick.
    const rejected = new Map<string, number>();

    for (;;) {
        if (isCancelled()) {
            return { kind: "cancelled" };
        }

        const found = await detectBootloaders();
        const present = new Set(found.map(keyOf));
        const now = Date.now();
        for (const [key, at] of [...rejected]) {
            if (!present.has(key) || now - at > RECHECK_MS) {
                rejected.delete(key);
            }
        }

        const ready: DetectedBoot[] = [];
        for (const board of found) {
            if (!board.ambiguous || !verify) {
                ready.push(board);
                continue;
            }
            const key = keyOf(board);
            if (rejected.has(key)) {
                continue;
            }
            if (await verify(board)) {
                ready.push(board);
            } else {
                rejected.set(key, Date.now());
            }
        }

        if (ready.length > 0) {
            return { kind: "found", boards: ready };
        }
        if (Date.now() >= deadline) {
            return { kind: "timeout" };
        }
        await new Promise((r) => setTimeout(r, pollMs));
    }
}
