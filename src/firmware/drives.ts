/**
 * Finding, and writing to, a UF2 bootloader drive.
 *
 * Every part of this is platform-specific, because there is no portable way to
 * ask "what removable volumes are mounted":
 *
 *   Windows  drive letters.  Node cannot enumerate them, so probe C:..Z: for
 *            INFO_UF2.TXT directly.  A: and B: are skipped -- on the rare
 *            machine that still has a floppy controller, probing them stalls.
 *   macOS    everything lands under /Volumes, so one readdir finds it.
 *   Linux    the hard case.  There is no guaranteed auto-mounter: GNOME and
 *            KDE mount under /run/media/$USER or /media/$USER, a headless or
 *            minimal system mounts nothing at all.  /proc/mounts is the
 *            authority, and if the drive is not there the user must mount it
 *            (or point us at it) themselves.
 */

import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { parseInfoUf2 } from "./boards";

export interface Uf2Drive {
    /** Mount point: "E:\\" on Windows, "/Volumes/RPI-RP2", "/run/media/me/RP2350". */
    mount: string;
    /** `Board-ID` from INFO_UF2.TXT -- "RPI-RP2", "RP2350". */
    boardId: string;
    /** `Model`, for diagnostics when boardId is one we do not know. */
    model?: string;
}

const INFO = "INFO_UF2.TXT";

/** Read INFO_UF2.TXT at a mount point, or undefined if this is not a UF2 drive. */
async function readInfo(mount: string): Promise<Uf2Drive | undefined> {
    try {
        const text = await fs.readFile(path.join(mount, INFO), "utf8");
        const { boardId, model } = parseInfoUf2(text);
        if (!boardId) {
            return undefined;
        }
        return { mount, boardId, model };
    } catch {
        // Not a UF2 drive, not mounted, or not readable.  All the same to us.
        return undefined;
    }
}

/**
 * Undo the octal escaping /proc/mounts applies to mount points: a space is
 * written as "\040" and a tab as "\011".
 */
function unescapeMount(p: string): string {
    const bs = String.fromCharCode(92);
    return p
        .split(bs + "040").join(" ")
        .split(bs + "011").join(String.fromCharCode(9));
}

/** Mount points to probe on Linux, from /proc/mounts plus the usual auto-mount roots. */
async function linuxCandidates(): Promise<string[]> {
    const out = new Set<string>();

    // /proc/mounts is authoritative.  Fields are space-separated and paths are
    // octal-escaped, so a mount point containing a space arrives as "\040".
    try {
        const mounts = await fs.readFile("/proc/mounts", "utf8");
        for (const line of mounts.split("\n")) {
            const parts = line.split(" ");
            if (parts.length < 3) {
                continue;
            }
            const fsType = parts[2];
            if (fsType !== "vfat" && fsType !== "msdos" && fsType !== "exfat") {
                continue;
            }
            out.add(unescapeMount(parts[1]));
        }
    } catch {
        // No procfs.  Fall through to the well-known roots.
    }

    // Auto-mount roots, in case procfs was unreadable.
    const user = os.userInfo().username;
    for (const root of [`/run/media/${user}`, `/media/${user}`, "/media", "/mnt"]) {
        try {
            for (const name of await fs.readdir(root)) {
                out.add(path.join(root, name));
            }
        } catch {
            // Root does not exist on this distribution.
        }
    }
    return [...out];
}

/** Every mounted UF2 bootloader drive. Empty is the normal case when no board is in BOOTSEL. */
export async function findUf2Drives(): Promise<Uf2Drive[]> {
    let candidates: string[];

    if (process.platform === "win32") {
        candidates = [];
        for (let c = "C".charCodeAt(0); c <= "Z".charCodeAt(0); c++) {
            candidates.push(String.fromCharCode(c) + ":\\");
        }
    } else if (process.platform === "darwin") {
        try {
            candidates = (await fs.readdir("/Volumes")).map((n) => path.join("/Volumes", n));
        } catch {
            candidates = [];
        }
    } else {
        candidates = await linuxCandidates();
    }

    const found = await Promise.all(candidates.map(readInfo));
    return found.filter((d): d is Uf2Drive => d !== undefined);
}

/** True once the drive is gone -- which is how a successful UF2 write ends. */
export async function driveGone(mount: string): Promise<boolean> {
    return (await readInfo(mount)) === undefined;
}

/**
 * Write a .uf2 to a bootloader drive.
 *
 * The bootloader reboots the instant it has the last block, so the drive is
 * unmounted underneath us mid-write.  Depending on platform and timing that
 * surfaces as EIO, ENOENT, EBUSY, EPERM, or no error at all -- **the error is
 * the success path**, not a failure.  The only honest test is whether the
 * drive went away afterwards, so that is what is checked.
 */
export async function writeUf2(
    mount: string,
    data: Buffer,
    onProgress?: (written: number, total: number) => void,
): Promise<void> {
    const target = path.join(mount, "firmware.uf2");

    // Written in chunks rather than one writeFile so that progress is visible
    // and, more importantly, so a failure can be told apart from a success: the
    // drive vanishing means "the board rebooted" only if everything was handed
    // over first.  If the cable is pulled halfway the drive also vanishes, and
    // reporting that as a successful update would be the worst outcome here.
    const CHUNK = 64 * 1024;
    let written = 0;
    let writeError: unknown;

    try {
        const fh = await fs.open(target, "w");
        try {
            while (written < data.length) {
                const end = Math.min(written + CHUNK, data.length);
                await fh.write(data.subarray(written, end));
                written = end;
                onProgress?.(written, data.length);

                // A successful write() is not evidence the bytes reached the
                // board: Windows buffers, so a drive that has already been
                // unplugged can keep accepting writes for a while.  The marker
                // file vanishing is the earlier and more reliable signal, and
                // stopping here leaves `written` short so the caller below
                // reports a disconnect rather than success.
                if (written < data.length && await driveGone(mount)) {
                    break;
                }
            }
        } finally {
            // The board can reboot on the last block, so the close itself may
            // fail.  That is not a write failure.
            await fh.close().catch(() => undefined);
        }
    } catch (err) {
        writeError = err;
    }

    const complete = written >= data.length;

    // Give the board a moment to reset and drop the volume.
    for (let i = 0; i < 40; i++) {
        if (await driveGone(mount)) {
            if (complete) {
                return;
            }
            throw new Error(
                `${mount} disappeared after only ${Math.round(written / 1024)} KB of ` +
                `${Math.round(data.length / 1024)} KB was written. The board was ` +
                `disconnected mid-update and its firmware is incomplete. Reconnect it, ` +
                `hold BOOT, tap RESET and run the update again.`);
        }
        await new Promise((r) => setTimeout(r, 250));
    }

    if (writeError !== undefined) {
        throw writeError;
    }
    throw new Error(
        `Wrote ${target} but ${mount} is still mounted -- the board did not restart. ` +
        `The .uf2 may not match this chip.`);
}
