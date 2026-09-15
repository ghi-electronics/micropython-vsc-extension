// Copyright (c) GHI Electronics.
// SPDX-License-Identifier: MIT

/**
 * On F5, check whether the manifest has a newer firmware than the device is
 * running and, if so, offer to update.
 *
 * The check runs against the REPL (CDC0) rather than the debug channel: the
 * debug engine has no version command, and reaching into the REPL avoids
 * touching the firmware wire protocol at all -- so an older firmware works
 * exactly as it always did.  A brief Ctrl-C is sent to interrupt anything
 * running, which is disruptive only in the sense that F5 is about to reboot
 * the board seconds later anyway.
 */

import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as path from "path";
import { loadManifest, FirmwareFamily } from "./manifest";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let serialportModule: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function serialport(): any {
    if (!serialportModule) {
        serialportModule = require("serialport");
    }
    return serialportModule;
}

export interface DeviceVersion {
    /** From os.uname().version, e.g. "1.29.0-35-g29b4eb3685 on 2026-09-14". */
    version: string;
    /** From os.uname().machine, e.g. "SITCore SC13048 with STM32L452RE". */
    machine: string;
}

export interface UpdateAvailable {
    /** The manifest family the running firmware maps to (matched by update_fw_id). */
    family: FirmwareFamily;
    /** Version currently on the device. */
    currentVersion: string;
    /** Version in the manifest. */
    latestVersion: string;
}

/** How long we wait for the REPL to answer before giving up on the check. */
const REPL_TIMEOUT_MS = 4000;

/**
 * Ask the REPL what firmware it is running, using os.uname().
 *
 * Sentinels bracket the answer so leftover output on the port cannot masquerade
 * as the version string.  Returns undefined on any failure -- a stuck REPL, no
 * answer, malformed output -- so the caller can silently skip the check.
 */
export async function readDeviceVersion(replPort: string): Promise<DeviceVersion | undefined> {
    return new Promise<DeviceVersion | undefined>((resolve) => {
        let done = false;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let port: any;

        const finish = (v?: DeviceVersion): void => {
            if (done) {
                return;
            }
            done = true;
            clearTimeout(timer);
            try {
                if (port?.isOpen) {
                    port.close();
                }
            } catch { /* already closed */ }
            resolve(v);
        };

        const timer = setTimeout(() => finish(undefined), REPL_TIMEOUT_MS);

        try {
            port = new (serialport().SerialPort)(
                { path: replPort, baudRate: 115200 },
                (err: Error | null | undefined) => {
                    if (err) {
                        finish(undefined);
                        return;
                    }
                    // Two Ctrl-Cs to break out of nested try/except; \r flushes.
                    // Then the one-liner.  Sentinels are emitted as \x3c\x3c
                    // and \x3e\x3e so the *echo* of the source line does not
                    // contain the raw "<<" / ">>" bytes -- only the executed
                    // print does.  Without that trick the parser matched the
                    // echoed input before the real output arrived and read the
                    // machine string as our own Python fragment.
                    port.write("\r\x03\x03\r");
                    setTimeout(() => {
                        try {
                            port.write(
                                "import os as _o;_u=_o.uname();"
                                + "print('\\x3c\\x3cMPV'+_u.version+'|'"
                                + "+_u.machine+'MPV\\x3e\\x3e')\r",
                            );
                        } catch { finish(undefined); }
                    }, 200);
                });
        } catch {
            finish(undefined);
            return;
        }

        let buffer = "";
        port.on("data", (d: Buffer) => {
            buffer += d.toString("utf8");
            const start = buffer.indexOf("<<MPV");
            const end = buffer.indexOf("MPV>>");
            if (start >= 0 && end > start + 5) {
                const body = buffer.slice(start + 5, end);
                const bar = body.indexOf("|");
                if (bar > 0) {
                    finish({
                        version: body.slice(0, bar).trim(),
                        machine: body.slice(bar + 1).trim(),
                    });
                }
            }
        });
        port.on("error", () => finish(undefined));
    });
}

/**
 * Extract the update_fw_id token from an os.uname().machine string.
 *
 * The firmware bakes an identifier of the form "GHIMPDG###" (three or more
 * digits, up to GHIMPDG999) into MICROPY_HW_BOARD_NAME, so it appears in the
 * machine string as a single token.  A device from an older firmware without
 * this scheme returns undefined; the check silently skips in that case.
 */
export function extractUpdateFwId(machine: string): string | undefined {
    const m = /\bGHIMPDG\d{3,}\b/.exec(machine);
    return m ? m[0] : undefined;
}

/**
 * Normalise a version string so device and manifest can be compared.
 *
 * Two format differences trip a naive string compare:
 *
 *   1. os.uname().version tacks " on <date>" onto the end; the manifest does
 *      not.  Strip it.
 *
 *   2. MicroPython rewrites `git describe` output into a semver-compatible
 *      form: "v1.29.0-37-gb1602d56fe" becomes "1.29.0-37.gb1602d56fe" (all
 *      dashes after the first turned into dots).  See py/makeversionhdr.py.
 *      The manifest generator uses the raw `git describe`, so it stays as
 *      "1.29.0-37-gb1602d56fe".  Normalise dots-back-to-dashes in the
 *      prerelease field so both compare equal on the same commit.
 *
 *   3. `-dirty` marks a build made with local modifications.  Strip it so a
 *      locally-modified build compares equal to the clean release at the
 *      same commit -- the update prompt is for "there is a newer commit",
 *      not "please rebuild cleanly".
 */
function normaliseVersion(v: string): string {
    let s = v.trim().replace(/^v/i, "").split(" on ")[0].trim();
    const dash = s.indexOf("-");
    if (dash > 0) {
        s = s.slice(0, dash + 1) + s.slice(dash + 1).replace(/\./g, "-");
    }
    s = s.replace(/-dirty$/, "");
    return s;
}

/**
 * Run the check.  Returns an update descriptor when the device is behind the
 * manifest, or undefined for every other case (no manifest, no answer, no
 * matching family, same version).  Never throws -- a failed check must not
 * take F5 down.
 *
 * `log` is optional and only used for diagnostics: every step reports why it
 * did or did not proceed, so a user who says "the prompt does not appear" can
 * point at the exact reason without a debugger.
 */
export async function checkForUpdate(
    context: vscode.ExtensionContext,
    replPort: string,
    log?: (s: string) => void,
): Promise<UpdateAvailable | undefined> {
    const note = (s: string): void => { if (log) { log("[updateCheck] " + s); } };

    let families: FirmwareFamily[];
    try {
        const loaded = await loadManifest(context);
        families = loaded.manifest.families;
        note(`manifest loaded from ${loaded.url} (${families.length} families, stale=${loaded.stale})`);
    } catch (e) {
        note(`manifest load failed: ${(e as Error).message} -- skipping check`);
        return undefined;
    }

    note(`querying REPL on ${replPort}...`);
    const dev = await readDeviceVersion(replPort);
    if (!dev) {
        note("no answer from REPL within timeout -- skipping check");
        return undefined;
    }
    note(`device: version="${dev.version}" machine="${dev.machine}"`);

    const fwId = extractUpdateFwId(dev.machine);
    if (!fwId) {
        note("machine string carries no GHIMPDG### token -- skipping check "
            + "(older firmware, or third-party board)");
        return undefined;
    }
    note(`device update_fw_id=${fwId}`);

    const family = families.find((f) => f.update_fw_id === fwId);
    if (!family) {
        note(`no manifest family with update_fw_id=${fwId} -- skipping check`);
        return undefined;
    }
    if (!family.version) {
        note(`family ${family.id} has no version in the manifest -- skipping check`);
        return undefined;
    }
    note(`matched family ${family.id}, manifest version=${family.version}`);

    const current = normaliseVersion(dev.version);
    const latest = normaliseVersion(family.version);
    if (current === "" || latest === "") {
        note(`empty version after normalisation (current="${current}" latest="${latest}") -- skipping`);
        return undefined;
    }
    if (current === latest) {
        note(`versions match (${current}) -- no update needed`);
        return undefined;
    }

    note(`update available: ${current} -> ${latest}`);
    return { family, currentVersion: current, latestVersion: latest };
}

/**
 * Set checkFirmwareUpdate: false on every MicroPython configuration in the
 * folder's launch.json, so the prompt does not appear again on F5.
 *
 * Editing the file's text (rather than round-tripping through
 * WorkspaceConfiguration.update) preserves every JSONC comment the user or
 * the scaffold wrote -- launch.json is JSONC and reserialising it strips all
 * `//` lines.  The regex targets the field's value only; everything else
 * (surrounding whitespace, comments, other fields) survives byte-for-byte.
 *
 * A launch.json that does not already have the field falls back to the
 * configuration API, which does strip comments but is the only way to insert
 * a new key safely.  Scaffolded projects always have the field, so the
 * fallback almost never fires in practice.
 */
export async function disableForProject(folder: vscode.WorkspaceFolder | undefined): Promise<void> {
    if (!folder) {
        return;
    }
    const filePath = path.join(folder.uri.fsPath, ".vscode", "launch.json");

    try {
        const text = await fs.readFile(filePath, "utf8");
        // Only flip explicit trues to false, and only when the match is on a
        // live line -- a commented-out `// "checkFirmwareUpdate": true` has no
        // runtime effect, so flipping the boolean *inside* the comment would
        // silently do nothing and the user would be prompted again next F5.
        const re = /("checkFirmwareUpdate"\s*:\s*)true\b/g;
        let touched = false;
        const updated = text.replace(re, (match, prefix, offset: number) => {
            const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
            if (text.slice(lineStart, offset).includes("//")) {
                return match;                  // inside a // comment: leave alone
            }
            touched = true;
            return prefix + "false";
        });
        if (touched) {
            await fs.writeFile(filePath, updated, "utf8");
            return;
        }
    } catch {
        // Read failure falls through: the config-API path below still handles it.
    }

    // The field is not present as a boolean literal (missing entirely, or the
    // file could not be read as text).  Fall back to the API path, which
    // strips JSONC comments but at least correctly inserts the field.
    const config = vscode.workspace.getConfiguration("launch", folder.uri);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const configs = (config.get<any[]>("configurations") ?? []).map((c) => ({ ...c }));
    let changed = false;
    for (const c of configs) {
        if (c.type === "micropython" && c.checkFirmwareUpdate !== false) {
            c.checkFirmwareUpdate = false;
            changed = true;
        }
    }
    if (changed) {
        await config.update(
            "configurations", configs, vscode.ConfigurationTarget.WorkspaceFolder);
    }
}
