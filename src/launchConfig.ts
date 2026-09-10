/**
 * The two decisions F5 makes before a session can start.
 *
 * They live here rather than in extension.ts because both are wrong only in
 * someone else's project -- one when a launch.json already exists, the other
 * when a file other than main.py is in front -- and extension.ts cannot be
 * loaded outside the extension host, so nothing there can be tested.
 */
import * as path from "path";
import * as fs from "fs";

/**
 * Does this project already have a MicroPython launch configuration?
 *
 * Asked of the parsed configurations, not of the file. launch.json is JSONC --
 * comments and trailing commas are legal and people use them -- and VS Code
 * already has a reader for it. Grepping the text here instead would disagree
 * with VS Code on exactly the files that need the most care, such as one where
 * the only "micropython" is inside a comment.
 *
 * The distinction that matters: a launch.json existing is not the same as this
 * debugger being set up in it. Treating the two as one leaves a project whose
 * launch.json holds only a Python configuration with no way to discover that
 * F5 could drive the board.
 */
export function hasMicroPythonConfig(configurations: unknown): boolean {
    return Array.isArray(configurations)
        && configurations.some((c) =>
            !!c && typeof c === "object"
            && (c as { type?: unknown }).type === "micropython");
}

/**
 * The file the board should start at when there is no launch.json to say.
 *
 * main.py wins whenever it exists, because that is the file MicroPython itself
 * runs at boot. Taking the active editor instead means pressing F5 while
 * reading a driver module deploys the project and enters at that module, which
 * defines its class and exits -- indistinguishable, from the outside, from the
 * debugger having done nothing.
 *
 * The active editor is still the fallback, so a folder built around some other
 * entry point keeps working.
 */
export function chooseProgram(
    root: string | undefined,
    activePythonFile: string | undefined,
    exists: (p: string) => boolean = fs.existsSync,
): string | undefined {
    if (root) {
        const main = path.join(root, "main.py");
        if (exists(main)) {
            return main;
        }
    }
    return activePythonFile;
}
