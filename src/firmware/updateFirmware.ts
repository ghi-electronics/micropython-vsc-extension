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
import { allBoards, GENERIC_BOOTLOADER_HINT, type BootBoard } from "./boards";
import { detectBootloaders, waitForBootloader, type DetectedBoot } from "./detect";
import { writeUf2 } from "./drives";
import { EspNotRespondingError, flashEsp, probeEspChip } from "./espFlash";
import {
    downloadFirmware, isAvailable, loadManifest, md5, parseHexId,
    type FirmwareFamily, type Manifest,
} from "./manifest";

/**
 * How an update ended, so a caller can offer the right next thing.
 *
 * "no-index" is separated from "failed" because it is the one failure with an
 * obvious alternative: the firmware list could not be reached, but the user may
 * well already have a firmware file.
 */
export type UpdateResult = "flashed" | "cancelled" | "no-index" | "failed";

/** Remembers which board was chosen last, so it is offered first. */
const LAST_BOARD_KEY = "firmware.lastBoardId";

/**
 * Ask the user to put the board into its bootloader, and wait.
 *
 * Shown as a cancellable progress notification rather than a modal dialog: a
 * modal would have to be dismissed by hand after the board appears, which is
 * exactly the friction this command exists to remove.
 */
async function promptForBootloader(
    verify: (board: DetectedBoot) => Promise<boolean>,
    kind?: DetectedBoot["kind"],
    published?: string,
): Promise<DetectedBoot[] | undefined> {
    // The chosen board's own wording, from the index.  The fallback is for the
    // one case with no index to read: installing from a local file offline.
    const hint = published ?? GENERIC_BOOTLOADER_HINT;

    const result = await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: "Waiting for a board in its bootloader",
            cancellable: true,
        },
        async (progress, token) => {
            progress.report({ message: hint });
            return waitForBootloader(() => token.isCancellationRequested, verify, kind);
        });

    if (result.kind === "cancelled") {
        return undefined;
    }
    if (result.kind === "timeout") {
        fail("No board found",
            `Nothing appeared in a bootloader. Check the USB cable, then try again.

${hint}`);
        return undefined;
    }
    return result.boards;
}

/**
 * Ask an ambiguous device whether it is genuinely in its bootloader.
 *
 * The XIAO ESP32-S3 shows the same VID, PID and serial number running as it
 * does in its ROM loader, so USB cannot answer this -- measured on the board,
 * not assumed.  What does answer it is the ROM itself: it replies to esptool
 * and a running application does not.  Nothing is written; this only connects
 * and asks what chip it is.
 */
function makeVerifier(output: vscode.OutputChannel) {
    return async (board: DetectedBoot): Promise<boolean> => {
        if (board.kind !== "esp-rom" || !board.ambiguous || !board.port) {
            return true;
        }
        try {
            const chip = await probeEspChip({
                port: board.port,
                vendorId: board.vendorId ?? 0,
                productId: board.productId ?? 0,
                log: (line) => output.appendLine(line),
            });
            output.appendLine(`${board.port}: ${chip}, in its bootloader`);
            return true;
        } catch (err) {
            if (err instanceof EspNotRespondingError) {
                output.appendLine(
                    `${board.port}: no reply, so not in its bootloader -- still waiting`);
                return false;
            }
            throw err;
        }
    };
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
 * Offer a list of boards, most-recently-used first, and remember the answer.
 *
 * Shared so the ambiguity prompt and the "not my board" escape hatch look and
 * behave identically.
 */
async function pickFrom(
    context: vscode.ExtensionContext,
    choices: BootBoard[],
    title: string,
    placeHolder: string,
): Promise<BootBoard | undefined> {
    const last = context.globalState.get<string>(LAST_BOARD_KEY);
    const items = [...choices].sort((a, b) =>
        (a.id === last ? -1 : 0) - (b.id === last ? -1 : 0));

    const pick = await vscode.window.showQuickPick(
        items.map((b) => ({
            // The id names the family; the second line lists the parts it
            // covers, because one entry often serves several devices.
            label: b.id,
            description: b.id === last ? "used last time" : undefined,
            detail: b.deviceSupport,
            board: b,
        })),
        { title, placeHolder, ignoreFocusOut: true });

    if (pick) {
        await context.globalState.update(LAST_BOARD_KEY, pick.board.id);
    }
    return pick?.board;
}

/** Every board the index publishes for a given flashing mechanism. */
function publishedFor(manifest: Manifest, kind?: DetectedBoot["kind"]): BootBoard[] {
    return manifest.families
        .filter((f) => kind === undefined || (f.kind ?? "uf2-drive") === kind)
        .map((f) => ({
            id: f.id,
            deviceSupport: f.device_support ?? f.id,
            // "uf2-drive" is the documented default when an entry omits kind.
            kind: f.kind ?? "uf2-drive",
            chip: f.chip,
            resetBefore: f.resetBefore,
            enterBootloader: f.enterBootloader,
        }));
}

/**
 * Ask which board the user has.
 *
 * Always asked, never inferred.  A bootloader reports its chip, not its board:
 * every RP2350 looks like a Pico 2 in BOOTSEL and every S3 looks alike in its
 * ROM loader, so inference was right often but not always, and its mistakes
 * were silent ones that overwrote firmware.
 *
 * The list is the published index, so boards can be renamed, added or withdrawn
 * on the website without shipping an extension.  detect.ts still works out what
 * a bootloader could be, and DetectedBoot.candidates still carries it, should
 * inference ever be wanted again.
 */
async function chooseBoard(
    context: vscode.ExtensionContext,
    manifest: Manifest,
): Promise<BootBoard | undefined> {
    const choices = publishedFor(manifest);
    if (choices.length === 0) {
        fail("No firmware available", "The firmware list has no boards in it.");
        return undefined;
    }
    return pickFrom(context, choices,
        "Which board do you have?",
        "Pick your board. Choosing wrongly is recoverable: put it back in its "
        + "bootloader and install again");
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
            title: `Installing on ${entry.id}`,
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
                // esptool says "Erasing flash (this may take a while)..." and
                // then goes quiet for a minute on a large chip.  Showing that
                // is the difference between "working" and "hung".
                onStatus: (line) => progress.report({ message: line }),
                port: found.port!,
                vendorId: found.vendorId ?? 0,
                productId: found.productId ?? 0,
                data,
                address: entry.address ?? 0,
                expectedChip: entry.chip,
                before: entry.resetBefore,
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
        ? "The board has restarted. Press F5 to start debugging."
        : "Tap RESET on the board, then press F5 to start debugging.";
    void vscode.window.showInformationMessage(
        `Your ${entry.id} is ready to debug`,
        { modal: true, detail }, "OK");
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
): Promise<UpdateResult> {
    if (busy) {
        fail("An update is already running",
            "Wait for it to finish before starting another.");
        return "failed";
    }
    busy = true;
    try {
        return await updateFirmwareInner(context, output);
    } catch (err) {
        fail("Firmware update failed", describe(err));
        return "failed";
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
): Promise<UpdateResult> {
    let loaded: Awaited<ReturnType<typeof loadManifest>>;
    try {
        // Shown even though it is usually quick.  The first fetch of a session
        // pays for DNS, TLS and the round trip, and with nothing on screen the
        // command looks like it did nothing at all -- so it gets clicked again,
        // and again, until the "already running" guard finally says something.
        // The feedback is the fix; the guard was only the symptom talking.
        loaded = await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: "Checking for firmware",
                cancellable: true,
            },
            async (progress, token) => {
                progress.report({ message: "Fetching the list of supported boards..." });
                return Promise.race([
                    loadManifest(context),
                    new Promise<never>((_resolve, reject) => {
                        token.onCancellationRequested(
                            () => reject(new vscode.CancellationError()));
                    }),
                ]);
            });
    } catch (err) {
        if (err instanceof vscode.CancellationError) {
            return "cancelled";
        }
        // loadManifest only throws about the index itself: unreachable, not
        // configured, or malformed.  The caller can offer a local file instead.
        output.appendLine(`firmware index unavailable: ${(err as Error).message}`);
        return "no-index";
    }
    const { manifest, url: indexUrl, stale } = loaded;

    // The board is chosen first, so everything after it follows from one
    // deliberate answer rather than a guess: which bootloader to wait for, what
    // to tell the user to press, and which chip must answer before a write.
    const board = await chooseBoard(context, manifest);
    if (!board) {
        return "cancelled";
    }

    let entry = manifest.families.find((f) => f.id === board.id);
    if (!entry) {
        fail(`No firmware published for ${board.id}`,
            `The firmware list has no entry with the id "${board.id}". ` +
            `It may not be released yet.`);
        return "failed";
    }

    // A board that is listed but has no firmware behind it yet.  It appears in
    // the list on purpose -- the supported list should show what is coming --
    // so this is an ordinary outcome, not an error.
    if (!isAvailable(entry)) {
        void vscode.window.showInformationMessage(
            `Firmware for ${entry.id} is not ready yet`,
            {
                modal: true,
                detail: `Support for ${entry.device_support} is on the way. `
                    + "There is nothing to install today.",
            },
            "OK");
        return "cancelled";
    }

    for (;;) {
        // No version string in the dialog.  It means nothing to the person
        // reading it and a build id reads as something having gone wrong; it
        // goes to the output channel, where support can find it.
        output.appendLine(`installing ${entry.id} ${entry.version}`);

        const go = await vscode.window.showWarningMessage(
            `Add real debugging to your ${entry.id}?`,
            {
                modal: true,
                detail:
                    "Files stored on the device will be erased." +
                    (stale ? "\n\nUsing the firmware list saved from last time." : ""),
            },
            "Install", "Choose a Different Board");

        if (go === "Install") {
            break;
        }
        if (go !== "Choose a Different Board") {
            return "cancelled";
        }

        const other = await pickFrom(context, publishedFor(manifest),
            "Which board do you have?",
            "Every board with published firmware");
        if (!other) {
            return "cancelled";
        }
        const swapped = manifest.families.find((f) => f.id === other.id);
        if (!swapped) {
            fail(`No firmware published for ${other.id}`,
                `The firmware list has no entry with the id "${other.id}".`);
            return "failed";
        }
        entry = swapped;
    }

    // Downloaded before the board is asked for, not after.
    //
    // By the time the user is pressing buttons everything is in hand and
    // verified, so the wait ends in an immediate write.  It also removes a
    // failure case outright: the board cannot leave its bootloader during the
    // download, because it is not in one yet.
    let data: Buffer;
    try {
        data = await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `Downloading firmware for ${entry.id}`,
                cancellable: true,
            },
            async (progress, token) => {
                const report = percentReporter(progress, "Downloaded");
                return downloadFirmware(context, entry, indexUrl, report, token);
            });
    } catch (err) {
        if (err instanceof vscode.CancellationError) {
            return "cancelled";
        }
        fail("Download failed", (err as Error).message);
        return "failed";
    }

    // Now, and only now, ask for the board -- in this board's own words.
    const kind = entry.kind ?? "uf2-drive";
    const verify = makeVerifier(output);
    let ready = (await detectBootloaders())
        .filter((b) => b.kind === kind && !b.ambiguous);
    if (ready.length === 0) {
        const waited = await promptForBootloader(verify, kind, entry.enterBootloader);
        if (!waited) {
            return "cancelled";
        }
        ready = waited;
    }
    const found = await pickBootloader(ready);
    if (!found) {
        return "cancelled";
    }

    try {
        await flash(found, entry, data, output);
    } catch (err) {
        fail("Flashing failed", describe(err));
        return "failed";
    }
    reportDone(found, entry);
    return "flashed";
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
    // Same shape as the indexed path: the board is chosen first, always.  There
    // is no index here, so the list is what this build knows how to reach.
    const board = await chooseBoard(context, {
        schemaVersion: 1,
        families: allBoards().map((b) => ({
            ...b, device_support: b.deviceSupport, version: "from file",
            // Local file: no download, so a placeholder url that still reads as
            // available. isAvailable() rejects "" and "N/A".
            url: b.id,
        })),
    });
    if (!board) {
        return;
    }

    const wantUf2 = board.kind === "uf2-drive";
    const picked = await vscode.window.showOpenDialog({
        title: `Firmware for ${board.id}`,
        canSelectMany: false,
        filters: wantUf2 ? { "UF2 firmware": ["uf2"] } : { "ESP32 image": ["bin"] },
    });
    if (!picked || picked.length === 0) {
        return;
    }
    const data = await fs.readFile(picked[0].fsPath);

    const entry: FirmwareFamily = {
        id: board.id,
        device_support: board.deviceSupport,
        kind: board.kind,
        version: "from file",
        url: picked[0].fsPath,
        md5: md5(data),
        address: 0,
        chip: board.chip,
        resetBefore: board.resetBefore,
        enterBootloader: board.enterBootloader,
    };

    // Only now ask for the board, and only if one is not already waiting.
    const verify = makeVerifier(output);
    let ready = (await detectBootloaders())
        .filter((b) => b.kind === board.kind && !b.ambiguous);
    if (ready.length === 0) {
        const waited = await promptForBootloader(verify, board.kind, board.enterBootloader);
        if (!waited) {
            return;
        }
        ready = waited;
    }
    const found = await pickBootloader(ready);
    if (!found) {
        return;
    }

    try {
        await flash(found, entry, data, output);
    } catch (err) {
        fail("Flashing failed", describe(err));
        return;
    }
    reportDone(found, entry);
}
