// Copyright (c) GHI Electronics.
// SPDX-License-Identifier: MIT

/**
 * What to do when F5 is pressed on a board that cannot be debugged.
 *
 * This is the first thing a new user meets: install the extension, open a
 * project, press F5 -- and the board is running whatever it shipped with,
 * which has no debug interface.  Saying so and stopping would be accurate
 * and useless.  Listing steps to follow would be worse, because following
 * steps by hand is the thing this extension exists to remove.  So it asks
 * one question and, if the answer is yes, kicks the installer off in the
 * background and lets the caller end its own task.
 *
 * The launch that started it does not carry across the install.  A live
 * debug session against a board that is being reflashed and reset is a
 * source of hidden bugs; the installer is a self-contained flow with its
 * own "ready to debug" prompt, and the user re-presses F5 once that
 * prompt appears.
 *
 * The question does not speculate about what the board is running.  We
 * cannot know that, and a guess in a dialog reads as fact.
 *
 * Every path leads somewhere.  If the firmware list cannot be reached,
 * the user is offered a firmware file instead rather than being told to
 * come back with an internet connection.
 *
 * Detecting the situation costs nothing: this firmware presents two CDC
 * interfaces where stock MicroPython presents one, so `findPorts()` has
 * already answered before a byte is sent.
 */

import * as vscode from "vscode";
import { detectBootloaders } from "./detect";
import type { UpdateResult } from "./updateFirmware";

/**
 * Ask the user whether to install the debugger firmware.  Returns true
 * when the install was kicked off (in the background); the caller then
 * ends its own task and lets the installer run alone.  Returns false
 * when the user declined, or when the board is sitting in its
 * bootloader (a different fix, explained in the prompt).
 *
 * Before offering the install, we check whether a board is sitting in
 * its bootloader (UF2 drive mounted, or a serial ROM loader answering)
 * -- because "install debugger firmware" is misleading when the firmware
 * IS installed and the board just needs a tap on RESET to run it.  The
 * commonest cause is finishing a firmware update and pressing F5
 * without resetting first.
 */
export async function offerFirmwareInstall(): Promise<boolean> {
    const inBootloader = await detectBootloaders();
    if (inBootloader.length > 0) {
        await vscode.window.showWarningMessage(
            "The board is in bootloader mode",
            {
                modal: true,
                detail: "Tap RESET on the board to run the firmware, then press F5 again. "
                    + "If you want to reinstall the firmware instead, use "
                    + "\"MicroPython: Update Device Firmware\" from the Command Palette.",
            },
            "OK");
        return false;
    }

    const yes = await vscode.window.showWarningMessage(
        "Do you want to install the firmware that supports debugging?",
        {
            modal: true,
            detail: "No MicroPython debugger firmware was found on the board, or no board is connected. "
                + "Installing replaces the firmware on the board and erases files stored on it.",
        },
        "Install");
    if (yes !== "Install") {
        return false;
    }

    // Fire and forget: the caller (F5, or a device command) is done, and
    // this flow finishes on its own with the updater's "ready to debug"
    // prompt.  Any error surface is the updater's -- swallowing it here
    // would leave a silent failure.
    void runInstallFlow();
    return true;
}

/**
 * The install pipeline.  Runs the updater; if the manifest is
 * unreachable, falls back to a file the user already has, so a bench
 * with no network still has a way forward.
 */
async function runInstallFlow(): Promise<void> {
    const result = await vscode.commands.executeCommand<UpdateResult>(
        "micropython-debugger.updateFirmware");
    if (result !== "no-index") {
        return;
    }

    const fromFile = await vscode.window.showWarningMessage(
        "The firmware download could not be reached",
        {
            modal: true,
            detail: "Check the internet connection, or install from a firmware file "
                + "you already have.",
        },
        "Install from File");
    if (fromFile === "Install from File") {
        await vscode.commands.executeCommand("micropython-debugger.flashFromFile");
    }
}
