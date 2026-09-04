/**
 * "Update Device Firmware" -- fetch the right firmware and put it on the board.
 *
 * The goal is that the user never visits a website, never picks a file, and
 * never has to know which .uf2 or .bin belongs to their board.  The one thing
 * they do is the same on every board this extension supports: **hold BOOT and
 * tap RESET** (LDR on SITCore).  Everything after that is automatic.
 *
 * Two details do most of the work for how this feels:
 *
 *   - The "hold BOOT and tap RESET" prompt is already watching for the device,
 *     so it closes by itself the moment the board appears.  There is no Retry
 *     button to hunt for; the user presses the buttons and flashing starts.
 *
 *   - Nothing is written to a board until the download has been checked against
 *     its SHA-256.  By the time we flash, the board is already in its
 *     bootloader and cannot refuse a bad image, so verification has to happen
 *     before that point, not after.
 */

import * as vscode from "vscode";
import * as fs from "fs/promises";
import type { BootBoard } from "./boards";
import { detectBootloaders, waitForBootloader, type DetectedBoot } from "./detect";
import { writeUf2 } from "./drives";
import { flashEsp } from "./espFlash";
import {
    downloadFirmware, loadManifest, md5, parseHexId,
    type FirmwareFamily, type Manifest,
} from "./manifest";

/** Remembers which board an ambiguous RP2040 turned out to be, so we ask once. */
const LAST_BOARD_KEY = "firmware.lastBoardId";

/**
 * Ask the user to put the board into its bootloader, and wait.
 *
 * Shown as a cancellable progress notification rather than a modal dialog: a
 * modal would have to be dismissed by hand after the board appears, which is
 * exactly the friction this command exists to remove.
 */
async function promptForBootloader(): Promise<DetectedBoot[] | undefined> {
    const result = await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: "Waiting for a board in its bootloader",
            cancellable: true,
        },
        async (progress, token) => {
            progress.report({
                message: "Hold the BOOT button (LDR on SITCore) and tap RESET, then release BOOT.",
            });
            return waitForBootloader(() => token.isCancellationRequested);
        });

    if (result.kind === "cancelled") {
        return undefined;
    }
    if (result.kind === "timeout") {
        fail("No board found",
            "Nothing appeared in a bootloader. Check the USB cable, then hold BOOT " +
            "(LDR on SITCore), tap RESET, release BOOT, and run the command again.");
        return undefined;
    }
    return result.boards;
}

/**
 * Choose between boards when more than one is in a bootloader.
 *
 * Rare, but flashing whichever enumerated first would put the wrong firmware on
 * someone's board without ever mentioning that there was a choice.
 */
async function pickBootloader(boards: DetectedBoot[]): Promise<DetectedBoot | undefined> {
    if (boards.length === 1) {
        return boards[0];
    }
    const pick = await vscode.window.showQuickPick(
        boards.map((b) => ({
            label: b.label,
            description: b.kind === "uf2-drive" ? b.drive?.mount : b.port,
            board: b,
        })),
        {
            title: "More than one board is in its bootloader",
            placeHolder: "Choose which one to update",
            ignoreFocusOut: true,
        });
    return pick?.board;
}

/**
 * Decide which board we are looking at.
 *
 * An RP2040 in BOOTSEL cannot say whether it is a Pico or a QT Py -- both
 * report `Board-ID: RPI-RP2`, because that string comes from the chip's ROM
 * rather than the board.  So when the bootloader is ambiguous the user is
 * asked, with their previous answer offered first; RP2350 and ESP32 identify
 * themselves and are never asked about.
 */
async function chooseBoard(
    context: vscode.ExtensionContext,
    found: DetectedBoot,
): Promise<BootBoard | undefined> {
    if (found.candidates.length === 1) {
        return found.candidates[0];
    }

    const last = context.globalState.get<string>(LAST_BOARD_KEY);
    const items = [...found.candidates].sort((a, b) =>
        (a.id === last ? -1 : 0) - (b.id === last ? -1 : 0));

    const pick = await vscode.window.showQuickPick(
        items.map((b) => ({
            label: b.name,
            description: b.id === last ? "used last time" : undefined,
            board: b,
        })),
        {
            title: `Which ${found.label} board is this?`,
            placeHolder: "The bootloader does not identify the board, so this has to be confirmed",
            ignoreFocusOut: true,
        });

    if (pick) {
        await context.globalState.update(LAST_BOARD_KEY, pick.board.id);
    }
    return pick?.board;
}

/**
 * Report a failure in a dialog rather than a notification toast.
 *
 * Toasts truncate and then disappear.  The esptool module-resolution failure
 * arrived as "Cannot find module 'c:\Users\...\.vscode\extensio..." with the
 * part naming the actual problem cut off, which is the worst possible thing to
 * lose.  A dialog shows the whole message and waits to be dismissed.
 */
function fail(summary: string, detail?: string): void {
    void vscode.window.showErrorMessage(summary, { modal: true, detail }, "OK");
}

/** Turn a byte count into something worth showing next to a progress bar. */
function human(n: number): string {
    return n >= 1024 * 1024
        ? `${(n / 1024 / 1024).toFixed(1)} MB`
        : `${Math.round(n / 1024)} KB`;
}

/**
 * Drive a vscode progress bar from absolute byte counts.
 *
 * `progress.report` takes an increment, not a total, so the last reported
 * percentage has to be carried between calls.
 */
function percentReporter(
    progress: vscode.Progress<{ message?: string; increment?: number }>,
    verb: string,
) {
    let last = 0;
    return (done: number, total: number | undefined) => {
        const msg = total
            ? `${verb} ${human(done)} of ${human(total)}`
            : `${verb} ${human(done)}`;
        if (!total) {
            progress.report({ message: msg });
            return;
        }
        const pct = Math.min(100, (done / total) * 100);
        progress.report({ message: msg, increment: pct - last });
        last = pct;
    };
}

/** Write an already-verified image to a board that is sitting in its bootloader. */
async function flash(
    found: DetectedBoot,
    entry: FirmwareFamily,
    data: Buffer,
    output: vscode.OutputChannel,
): Promise<void> {
    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: `Flashing ${entry.name}`,
            cancellable: false,
        },
        async (progress) => {
            if (found.kind === "uf2-drive") {
                const report = percentReporter(progress, "Wrote");
                await writeUf2(found.drive!.mount, data,
                    (written, total) => report(written, total));
                return;
            }

            const report = percentReporter(progress, "Wrote");
            await flashEsp({
                port: found.port!,
                vendorId: found.vendorId ?? 0,
                productId: found.productId ?? 0,
                data,
                address: entry.address ?? 0,
                onProgress: (written, total) => report(written, total),
                log: (line) => output.appendLine(line),
            });
        });
}

/** What to tell the user once the image is on the board. */
function reportDone(found: DetectedBoot, entry: FirmwareFamily): void {
    // A native-USB ESP32 has nothing wired to DTR/RTS, so it cannot be restarted
    // from here.  Saying so beats leaving the board looking dead.
    const detail = found.kind === "uf2-drive"
        ? "The board has restarted and is running the new firmware."
        : "Tap RESET on the board to start the new firmware.";
    void vscode.window.showInformationMessage(
        `${entry.name} updated to ${entry.version}`,
        { modal: true, detail }, "OK");
}

/**
 * Widen the candidate list with boards the index declares.
 *
 * boards.ts is what this build ships knowing; the index is what exists today.
 * Merging the two means a board added to the website is offered as soon as it
 * is published, without waiting for an extension release -- provided it reaches
 * its bootloader the same way a board already supported does.
 */
function withManifestCandidates(found: DetectedBoot, manifest: Manifest): DetectedBoot {
    const known = new Set(found.candidates.map((c) => c.id));
    const extra: BootBoard[] = [];

    for (const f of manifest.families) {
        if (known.has(f.id) || !f.bootloader) {
            continue;
        }
        const matches = found.kind === "uf2-drive"
            ? f.bootloader.boardId?.toLowerCase() === found.drive?.boardId.toLowerCase()
            : parseHexId(f.bootloader.usb?.vid) === found.vendorId
                && parseHexId(f.bootloader.usb?.pid) === found.productId;
        if (matches) {
            extra.push({ id: f.id, name: f.name ?? f.id, kind: f.kind ?? found.kind });
        }
    }

    return extra.length === 0
        ? found
        : { ...found, candidates: [...found.candidates, ...extra] };
}

/**
 * True while an update is running.
 *
 * Two updates at once would race for the same board -- and on the esp32 path,
 * for the same serial port, where the second would fail with an opaque "access
 * denied" from the driver rather than anything a user could act on.
 */
let busy = false;

/**
 * The command.
 *
 * Works whether or not the board is already in its bootloader, so a user who
 * pressed the buttons before running the command is not made to do it twice.
 *
 * Everything is wrapped: an exception escaping into the extension host becomes
 * an unhandled rejection, which the user experiences as the command silently
 * doing nothing.  Whatever goes wrong, it gets reported.
 */
export async function updateFirmware(
    context: vscode.ExtensionContext,
    output: vscode.OutputChannel,
): Promise<void> {
    if (busy) {
        fail("An update is already running",
            "Wait for it to finish before starting another.");
        return;
    }
    busy = true;
    try {
        await updateFirmwareInner(context, output);
    } catch (err) {
        fail("Firmware update failed", describe(err));
    } finally {
        busy = false;
    }
}

/** Best-effort readable text for anything that can be thrown. */
function describe(err: unknown): string {
    if (err instanceof Error) {
        return err.message;
    }
    return typeof err === "string" ? err : JSON.stringify(err);
}

async function updateFirmwareInner(
    context: vscode.ExtensionContext,
    output: vscode.OutputChannel,
): Promise<void> {
    let candidates = await detectBootloaders();
    if (candidates.length === 0) {
        const waited = await promptForBootloader();
        if (!waited) {
            return;      // cancelled, or nothing turned up
        }
        candidates = waited;
    }
    const found = await pickBootloader(candidates);
    if (!found) {
        return;
    }

    let loaded: Awaited<ReturnType<typeof loadManifest>>;
    try {
        loaded = await loadManifest(context);
    } catch (err) {
        fail("Cannot load the firmware list", (err as Error).message);
        return;
    }

    const { manifest, url: indexUrl, stale } = loaded;

    const board = await chooseBoard(context, withManifestCandidates(found, manifest));
    if (!board) {
        return;
    }

    const entry = manifest.families.find((f) => f.id === board.id);
    if (!entry) {
        fail(`No firmware published for ${board.name}`,
            `The firmware list has no entry with the id "${board.id}". ` +
            `It may not be released yet.`);
        return;
    }

    const go = await vscode.window.showWarningMessage(
        `Install ${entry.name} firmware ${entry.version}?`,
        {
            modal: true,
            detail:
                "This replaces the firmware and erases files stored on the device." +
                (stale ? "\n\nThe firmware list could not be refreshed; using the cached copy." : ""),
        },
        "Install");
    if (go !== "Install") {
        return;
    }

    let data: Buffer;
    try {
        data = await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `Downloading ${entry.name} ${entry.version}`,
                cancellable: true,
            },
            async (progress, token) => {
                const report = percentReporter(progress, "Downloaded");
                return downloadFirmware(context, entry, indexUrl, report, token);
            });
    } catch (err) {
        if (err instanceof vscode.CancellationError) {
            return;
        }
        fail("Download failed", (err as Error).message);
        return;
    }

    // The board may have been unplugged while the download ran.
    const still = (await detectBootloaders()).find((d) => d.kind === found.kind);
    if (!still) {
        fail("The board left its bootloader",
            "Nothing was written to the device. Hold BOOT, tap RESET to put it back " +
            "into the bootloader, then run the command again.");
        return;
    }

    try {
        await flash(still, entry, data, output);
    } catch (err) {
        fail("Flashing failed", (err as Error).message);
        return;
    }
    reportDone(still, entry);
}

/**
 * "Flash Firmware from File" -- the escape hatch.
 *
 * For a firmware build that is not in the index: local builds during
 * development, and a board that has to be recovered while offline.
 */
export async function flashFromFile(
    context: vscode.ExtensionContext,
    output: vscode.OutputChannel,
): Promise<void> {
    if (busy) {
        fail("An update is already running",
            "Wait for it to finish before starting another.");
        return;
    }
    busy = true;
    try {
        await flashFromFileInner(context, output);
    } catch (err) {
        fail("Firmware update failed", describe(err));
    } finally {
        busy = false;
    }
}

async function flashFromFileInner(
    context: vscode.ExtensionContext,
    output: vscode.OutputChannel,
): Promise<void> {
    let candidates = await detectBootloaders();
    if (candidates.length === 0) {
        const waited = await promptForBootloader();
        if (!waited) {
            return;
        }
        candidates = waited;
    }
    const found = await pickBootloader(candidates);
    if (!found) {
        return;
    }

    const wantUf2 = found.kind === "uf2-drive";
    const picked = await vscode.window.showOpenDialog({
        title: `Firmware for ${found.label}`,
        canSelectMany: false,
        filters: wantUf2 ? { "UF2 firmware": ["uf2"] } : { "ESP32 image": ["bin"] },
    });
    if (!picked || picked.length === 0) {
        return;
    }

    const data = await fs.readFile(picked[0].fsPath);
    const board = await chooseBoard(context, found);
    if (!board) {
        return;
    }

    const entry: FirmwareFamily = {
        id: board.id,
        name: board.name,
        kind: board.kind,
        version: "from file",
        url: picked[0].fsPath,
        md5: md5(data),
        address: 0,
    };

    try {
        await flash(found, entry, data, output);
    } catch (err) {
        fail("Flashing failed", (err as Error).message);
        return;
    }
    reportDone(found, entry);
}
