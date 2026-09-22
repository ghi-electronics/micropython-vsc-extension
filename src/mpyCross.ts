// Copyright (c) GHI Electronics.
// SPDX-License-Identifier: MIT

/**
 * Compile a .py file to a .mpy on the host.
 *
 * Needed only by the single-CDC upload flow (STM32C071). Boards with a
 * runtime compiler on the device do not go through here.
 *
 * mpy-cross is the CPython-hosted MicroPython compiler; it is a small native
 * program with no shared-library dependencies. The extension looks for it in
 * three places, in order:
 *
 *   1. A bundled binary under resources/mpy-cross/<platform>-<arch>/, so a
 *      packaged extension can run on a customer's machine with no toolchain.
 *   2. `mpy-cross` on PATH, for a developer machine that already has one.
 *   3. `python -m mpy_cross`, for the PyPI wheel install path documented in
 *      the firmware build notes.
 *
 * Each candidate is probed with `--version` before use, so a broken shim or
 * a mis-architected binary reports clearly rather than failing at compile time.
 */

import * as vscode from "vscode";
import * as cp from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

export interface CompileResult {
    /** Bytes of the compiled .mpy. */
    mpy: Buffer;
    /** Absolute path of the temp file that was written and then read back. */
    outPath: string;
    /** Which resolver actually produced the .mpy, for diagnostics. */
    source: string;
}

/** How mpy-cross is invoked, once one has been located. */
interface Runner {
    /** For error messages: "resources/mpy-cross/win32-x64/mpy-cross.exe". */
    label: string;
    exec: string;
    /** Fixed arguments prepended to every call (e.g. ["-m", "mpy_cross"]). */
    preargs: string[];
}

/**
 * Locate mpy-cross without running the user's script through it yet.
 *
 * Returns undefined if nothing usable was found, so callers can produce a
 * single "install mpy-cross" error rather than repeatedly probing on every F5.
 */
async function locateMpyCross(
    context: vscode.ExtensionContext,
    log?: (s: string) => void,
): Promise<Runner | undefined> {
    const note = (s: string): void => { if (log) { log("[mpy-cross] " + s); } };

    // 1. Bundled binary. Directory layout mirrors what @vscode/vsce ships:
    //    resources/mpy-cross/<node platform>-<node arch>/mpy-cross[.exe]
    const bundled = path.join(
        context.extensionPath,
        "resources", "mpy-cross",
        `${process.platform}-${process.arch}`,
        process.platform === "win32" ? "mpy-cross.exe" : "mpy-cross");
    if (await tryRunner({ label: bundled, exec: bundled, preargs: [] }, note)) {
        return { label: bundled, exec: bundled, preargs: [] };
    }

    // 2. mpy-cross on PATH.
    const onPath = process.platform === "win32" ? "mpy-cross.exe" : "mpy-cross";
    if (await tryRunner({ label: onPath, exec: onPath, preargs: [] }, note)) {
        return { label: onPath, exec: onPath, preargs: [] };
    }

    // 3. PyPI wheel: `python -m mpy_cross`. Try python then python3.
    for (const python of ["python", "python3"]) {
        const r: Runner = { label: `${python} -m mpy_cross`, exec: python, preargs: ["-m", "mpy_cross"] };
        if (await tryRunner(r, note)) {
            return r;
        }
    }

    note("no mpy-cross found in bundled resources, PATH, or as a Python module");
    return undefined;
}

/** True when the candidate answers `--version` within a short window. */
function tryRunner(r: Runner, note: (s: string) => void): Promise<boolean> {
    return new Promise((resolve) => {
        try {
            const child = cp.spawn(r.exec, [...r.preargs, "--version"], {
                stdio: ["ignore", "pipe", "pipe"],
                windowsHide: true,
            });
            let out = "";
            child.stdout?.on("data", (b: Buffer) => { out += b.toString("utf8"); });
            child.stderr?.on("data", (b: Buffer) => { out += b.toString("utf8"); });
            child.on("error", () => resolve(false));
            child.on("exit", (code) => {
                const ok = code === 0;
                if (ok) {
                    note(`using ${r.label} (${out.trim().split("\n")[0]})`);
                }
                resolve(ok);
            });
            // A stalled probe should not hang F5.
            setTimeout(() => { try { child.kill(); } catch { /* gone */ } resolve(false); }, 5000);
        } catch {
            resolve(false);
        }
    });
}

/**
 * Run mpy-cross against a source file. Throws with a message worth showing to
 * the user when compilation fails; the caller writes it into the Debug Console.
 */
export async function compileToMpy(
    context: vscode.ExtensionContext,
    programPath: string,
    arch: string,
    log?: (s: string) => void,
): Promise<CompileResult> {
    const runner = await locateMpyCross(context, log);
    if (!runner) {
        throw new Error(
            "mpy-cross was not found. Install it with:\n"
            + "    python -m pip install mpy-cross\n"
            + "or place a mpy-cross binary on PATH, "
            + "then press F5 again.");
    }

    // Compile into the OS temp directory rather than beside the source, so a
    // read-only workspace still works and the artifact does not clutter the
    // project. The name mirrors the source so any diagnostic mpy-cross prints
    // is legible.
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mpycross-"));
    const outPath = path.join(tmpDir, path.basename(programPath).replace(/\.py$/i, "") + ".mpy");

    // Pass the source as a bare basename with cwd set to the program dir, so
    // the .mpy header records "main.py" rather than the absolute host path.
    // The device echoes that string back in stack frames; toLocalPath() joins
    // it against the workspace to resolve, so VS Code can display the source.
    const programDir = path.dirname(programPath);
    const programBase = path.basename(programPath);
    const args = [...runner.preargs, "-march=" + arch, "-o", outPath, programBase];
    if (log) { log(`[mpy-cross] ${runner.exec} ${args.join(" ")} (cwd=${programDir})`); }

    const { code, stdout, stderr } = await runProcess(runner.exec, args, programDir);
    if (code !== 0) {
        // mpy-cross writes syntax errors to stderr with the usual "file:line:
        // SyntaxError: ..." shape, which the VS Code Problems panel picks up
        // when it appears in the Debug Console output.
        const msg = [stdout, stderr].filter((s) => s.trim().length > 0).join("\n").trim();
        throw new Error(
            `mpy-cross exited with code ${code}${msg ? ":\n" + msg : ""}`);
    }

    const mpy = await fs.readFile(outPath);
    return { mpy, outPath, source: runner.label };
}

function runProcess(exec: string, args: string[], cwd?: string):
    Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
        try {
            const child = cp.spawn(exec, args, {
                stdio: ["ignore", "pipe", "pipe"],
                windowsHide: true,
                cwd,
            });
            let stdout = "";
            let stderr = "";
            child.stdout?.on("data", (b: Buffer) => { stdout += b.toString("utf8"); });
            child.stderr?.on("data", (b: Buffer) => { stderr += b.toString("utf8"); });
            child.on("error", (e) => reject(e));
            child.on("exit", (code) => resolve({ code, stdout, stderr }));
        } catch (e) {
            reject(e as Error);
        }
    });
}
