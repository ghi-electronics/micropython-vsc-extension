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
export const SERIAL_BOOTLOADERS: { vid: number; pid: number; board: BootBoard }[] = [
    {
        vid: 0x303a, pid: 0x0002,
        board: { id: "ESP32_GENERIC_S2", name: "ESP32-S2", kind: "esp-rom" },
    },
];

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
