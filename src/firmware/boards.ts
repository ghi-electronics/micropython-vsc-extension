/**
 * Board identity while a board is in its bootloader.
 *
 * A board in the bootloader is a different USB device from the same board
 * running firmware: different VID/PID, and on rp2 a mass-storage drive rather
 * than a serial port.  KNOWN_DEVICES in protocol.ts covers the running state;
 * this file covers the bootloader state, and the two never overlap.
 *
 * The awkward fact this file exists to manage: **an RP2040 in BOOTSEL does not
 * say which board it is.**  A Pico and a QT Py RP2040 both enumerate as
 * 2e8a:0003 and both write `Board-ID: RPI-RP2` into INFO_UF2.TXT, because that
 * string comes from the chip's ROM, not the board.  RP2350 is distinguishable
 * (different ROM, different drive label), so a Pico 2 needs no prompt.
 */

/** How firmware reaches the chip once it is in the bootloader. */
export type FlashKind =
    /** Copy a .uf2 onto a mass-storage drive the bootloader exposes. */
    | "uf2-drive"
    /** Espressif ROM loader over a serial port (esptool protocol). */
    | "esp-rom";

export interface BootBoard {
    /** Stable id, matches the `id` field in the firmware manifest. */
    id: string;
    /** Shown to the user. */
    name: string;
    kind: FlashKind;
    /**
     * Chip this board carries, as esptool reports it ("ESP32-S3").
     *
     * Checked against the chip that actually answers before anything is
     * written, because a serial bootloader's USB identity is not always
     * specific enough to be trusted on its own -- see SERIAL_BOOTLOADERS.
     */
    chip?: string;
    /**
     * esptool's "before" mode for this board, when the default will not do.
     *
     * The S3 needs "usb_reset": its ROM loader is reached over USB Serial/JTAG,
     * which can reset the part straight back into download mode, and without
     * that a stub left running from an earlier connection reports nonsense
     * flash geometry and the write is refused.  The S2 must NOT do this -- its
     * native-USB CDC has no such path, so a reset would simply boot the
     * application and leave the bootloader entirely.
     */
    resetBefore?: string;
}

/**
 * Chip families we can recognise from a UF2 drive.
 *
 * Keyed by the `Board-ID:` line of INFO_UF2.TXT, which the ROM bootloader
 * writes.  `boards` lists every supported board that reports that id -- more
 * than one means the user has to be asked which they have.
 */
export const UF2_FAMILIES: { boardId: string; label: string; boards: BootBoard[] }[] = [
    {
        boardId: "RPI-RP2",
        label: "RP2040",
        boards: [
            { id: "RPI_PICO", name: "Raspberry Pi Pico", kind: "uf2-drive" },
            { id: "ADAFRUIT_QTPY_RP2040", name: "Adafruit QT Py RP2040", kind: "uf2-drive" },
        ],
    },
    {
        boardId: "RP2350",
        label: "RP2350",
        boards: [
            { id: "RPI_PICO2", name: "Raspberry Pi Pico 2", kind: "uf2-drive" },
        ],
    },
];

/**
 * Bootloaders that appear as a serial port rather than a drive.
 *
 * The ESP32-S2/S3 ROM loader enumerates as a CDC device with Espressif's VID
 * and a PID fixed in ROM -- 0x0002 on the S2.  Note this is a different PID
 * from the running firmware (0x4002), so the two states never collide.
 */
export const SERIAL_BOOTLOADERS: {
    vid: number; pid: number; board: BootBoard;
    /**
     * True when this identity does not by itself mean "in the bootloader".
     *
     * The XIAO ESP32-S3 presents the same VID, PID and serial number whether it
     * is running or sitting in its ROM loader, because both use the chip's
     * USB Serial/JTAG unit.  Measured on the board, not assumed.  Such a device
     * has to be asked -- the ROM answers esptool and a running application does
     * not -- before the user is told a board is ready to flash.
     */
    ambiguous?: boolean;
}[] = [
    {
        // ESP32-S2 ROM, over the OTG CDC. Specific to the S2.
        vid: 0x303a, pid: 0x0002,
        board: {
            id: "ESP32_GENERIC_S2", name: "ESP32-S2",
            kind: "esp-rom", chip: "ESP32-S2",
        },
    },
    {
        // 0x1001 is Espressif's USB Serial/JTAG unit, which is how the S3
        // presents its ROM loader -- but the C3, C6 and H2 use the same
        // identity, so this PID says "some Espressif part", not "an S3".
        // Those chips are out of scope (12.7: USB Serial/JTAG cannot carry a
        // second CDC), so nothing else here claims this id; the `chip` field
        // is what actually stops a C3 being given S3 firmware.
        vid: 0x303a, pid: 0x1001,
        board: {
            id: "SEEED_XIAO_ESP32S3", name: "Seeed XIAO ESP32-S3",
            kind: "esp-rom", chip: "ESP32-S3", resetBefore: "usb_reset",
        },
        ambiguous: true,
    },
];

/**
 * How to reach the bootloader, keyed by the USB identity a board shows while
 * it is running normally.
 *
 * The gesture is not the same on every board, and getting it wrong is not a
 * nicety: **a Raspberry Pi Pico has no RESET button at all.**  It has one
 * button, marked BOOTSEL, and the way in is to hold it while the USB cable is
 * plugged in.  Telling that user to "hold BOOT and tap RESET" asks them to
 * press a button their board does not have, on the single manual step in the
 * whole product.
 *
 * Matched against the running device, because at the moment this is shown
 * nothing is in a bootloader yet -- that is what we are waiting for.
 */
export const BOOTLOADER_HINTS: { vid: number; pid: number; hint: string }[] = [
    {
        // Pico and Pico 2, ours or stock -- deliberately the same identity.
        vid: 0x2e8a, pid: 0x0005,
        hint: "Unplug the board, then plug the USB cable back in while holding BOOTSEL.",
    },
    {
        vid: 0x239a, pid: 0x80f8,
        hint: "Hold BOOT, tap RESET, then release BOOT.",
    },
    {
        // ESP32-S2/S3 running this firmware (two CDCs).
        vid: 0x303a, pid: 0x4002,
        hint: "Hold BOOT, tap RESET, then release BOOT.",
    },
    {
        // ESP32-S2/S3 running stock MicroPython (one CDC) -- the case a new
        // user is in before they have ever installed this firmware.
        vid: 0x303a, pid: 0x4001,
        hint: "Hold BOOT, tap RESET, then release BOOT.",
    },
    {
        vid: 0x1b9f, pid: 0xf105,
        hint: "Hold LDR, tap RESET, then release LDR.",
    },
];

/** Used when no board we recognise is connected, so it has to cover both styles. */
export const GENERIC_BOOTLOADER_HINT =
    "Hold the BOOT button and tap RESET, then release BOOT. If your board has no "
    + "RESET button -- a Raspberry Pi Pico has only BOOTSEL -- hold the button "
    + "while plugging the USB cable in instead.";

/** Every board this extension can flash, for manual selection and messages. */
export function allBoards(): BootBoard[] {
    const out: BootBoard[] = [];
    for (const fam of UF2_FAMILIES) {
        out.push(...fam.boards);
    }
    for (const s of SERIAL_BOOTLOADERS) {
        out.push(s.board);
    }
    return out;
}

/**
 * Parse INFO_UF2.TXT.
 *
 * The file is a handful of `Key: value` lines with CRLF endings.  Only
 * `Board-ID` is load-bearing; `Model` is returned because it is worth showing
 * in diagnostics when an unrecognised board turns up.
 */
export function parseInfoUf2(text: string): { boardId?: string; model?: string } {
    const out: { boardId?: string; model?: string } = {};
    for (const raw of text.split(/\r?\n/)) {
        const m = /^([A-Za-z-]+):\s*(.*)$/.exec(raw.trim());
        if (!m) {
            continue;
        }
        if (m[1].toLowerCase() === "board-id") {
            out.boardId = m[2].trim();
        } else if (m[1].toLowerCase() === "model") {
            out.model = m[2].trim();
        }
    }
    return out;
}

/** The family whose `Board-ID` matches, or undefined if we do not know it. */
export function familyForBoardId(boardId: string) {
    return UF2_FAMILIES.find((f) => f.boardId.toLowerCase() === boardId.toLowerCase());
}
