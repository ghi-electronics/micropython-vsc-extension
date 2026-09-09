/**
 * What to do when F5 is pressed on a board that cannot be debugged.
 *
 * This is the first thing a new user meets: install the extension, open a
 * project, press F5 -- and the board is running whatever it shipped with, which
 * has no debug interface.  Saying so and stopping would be accurate and
 * useless.  Listing steps to follow would be worse, because following steps by
 * hand is the thing this extension exists to remove.  So it asks one question
 * and, if the answer is yes, does the work and carries on with the F5 that
 * started it.
 *
 * The question does not speculate about what the board is running.  We cannot
 * know that, and a guess in a dialog reads as fact.
 *
 * Every path leads somewhere.  If the firmware list cannot be reached, the user
 * is offered a firmware file instead rather than being told to come back with
 * an internet connection.
 *
 * Detecting the situation costs nothing: this firmware presents two CDC
 * interfaces where stock MicroPython presents one, so `findPorts()` has already
 * answered before a byte is sent.
 */

import * as vscode from "vscode";
import { findPorts } from "../deviceLink";
import type { UpdateResult } from "./updateFirmware";

/** Wait for a board with a debug channel to appear, after an install. */
async function waitForDebugPort(timeoutMs = 30_000): Promise<string | undefined> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const ports = await findPorts();
        if (ports.debug) {
            return ports.debug;
        }
        if (Date.now() >= deadline) {
            return undefined;
        }
        await new Promise((r) => setTimeout(r, 500));
    }
}

/** Wait for the board to come back, with somewhere to click if it does not. */
async function waitForBoard(): Promise<string | undefined> {
    return vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: "Waiting for the board to restart",
            cancellable: true,
        },
        async (progress, token) => {
            // An rp2 board restarts itself the moment the .uf2 lands; an ESP32
            // cannot be restarted over the wire and has to be tapped.  Rather
            // than guess which one this is, say the thing that works for both.
            progress.report({
                message: "If it does not appear, tap RESET -- or unplug it and plug it back in.",
            });
            return Promise.race([
                waitForDebugPort(),
                new Promise<undefined>((resolve) => {
                    token.onCancellationRequested(() => resolve(undefined));
                }),
            ]);
        });
}

/**
 * Offer to install the firmware, and return the debug port if that worked.
 *
 * Returns undefined when the user declines or the board does not come back, in
 * which case the caller reports the original problem rather than inventing a
 * new one.
 */
export async function offerFirmwareInstall(): Promise<string | undefined> {
    const yes = await vscode.window.showWarningMessage(
        "Do you want to install the firmware that supports real debugging?",
        {
            modal: true,
            detail: "This replaces the firmware on the board and erases files stored on it.",
        },
        "Install");
    if (yes !== "Install") {
        return undefined;
    }

    const result = await vscode.commands.executeCommand<UpdateResult>(
        "micropython-debugger.updateFirmware");

    if (result === "flashed") {
        return waitForBoard();
    }
    if (result !== "no-index") {
        // Cancelled, or already reported by the updater itself.
        return undefined;
    }

    // The firmware list could not be reached.  Rather than stop here, offer the
    // one thing that still works without a network.
    const fromFile = await vscode.window.showWarningMessage(
        "The firmware download could not be reached",
        {
            modal: true,
            detail: "Check the internet connection, or install from a firmware file "
                + "you already have.",
        },
        "Install from File");
    if (fromFile !== "Install from File") {
        return undefined;
    }

    await vscode.commands.executeCommand("micropython-debugger.flashFromFile");
    return waitForBoard();
}
