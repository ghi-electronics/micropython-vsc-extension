/**
 * Extension entry point.
 *
 * The debug adapter runs in-process rather than as a separate executable:
 * there is no native dependency to ship and nothing to spawn, so the whole
 * extension is one VSIX.
 */
import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { MicroPythonDebugSession } from "./debugSession";
import { DeviceLink, findPorts } from "./deviceLink";
import { Cond } from "./protocol";
import { openDeviceShell } from "./replTerminal";
import { updateFirmware, flashFromFile } from "./firmware/updateFirmware";
import { offerFirmwareInstall } from "./firmware/notInstalled";
import { chooseProgram, hasMicroPythonConfig } from "./launchConfig";

const output = vscode.window.createOutputChannel("MicroPython Debugger");

export function activate(context: vscode.ExtensionContext): void {
    output.appendLine("MicroPython Debugger extension activated");
    context.subscriptions.push(output);
    // If this window just opened because "New Project" scaffolded a folder,
    // finish the wizard: focus main.py and show the ready toast.
    void openPendingProject(context);
    context.subscriptions.push(
        vscode.debug.registerDebugAdapterDescriptorFactory(
            "micropython", new InlineAdapterFactory()),
        vscode.debug.registerDebugConfigurationProvider(
            "micropython", new ConfigProvider()),
        vscode.commands.registerCommand(
            "micropython-debugger.selectDevice", showDevices),
        vscode.commands.registerCommand(
            "micropython-debugger.openShell", () => { void openShell(); }),
        vscode.commands.registerCommand(
            "micropython-debugger.deviceInfo", () => { void showDeviceInfo(); }),
        vscode.commands.registerCommand(
            "micropython-debugger.eraseDevice", () => { void eraseDevice(); }),
        vscode.commands.registerCommand(
            "micropython-debugger.newProject", () => { void newProject(context); }),
        vscode.commands.registerCommand(
            "micropython-debugger.updateFirmware",
            // Returns its result: the firmware-install offer needs to know
            // whether the index was simply unreachable, so it can suggest a
            // local file rather than leaving the user with nowhere to go.
            () => updateFirmware(context, output)),
        vscode.commands.registerCommand(
            "micropython-debugger.flashFromFile",
            () => { void flashFromFile(context, output); }),
        // After a session that ran without a launch.json, offer to save one --
        // F5 works without it, but only after choosing from the debugger list
        // every time, and that list also contains debuggers that cannot drive a
        // board.
        vscode.debug.onDidStartDebugSession((s) => { void offerLaunchJson(s); }),
    );
}

export function deactivate(): void { /* nothing to tear down */ }

class InlineAdapterFactory implements vscode.DebugAdapterDescriptorFactory {
    createDebugAdapterDescriptor(): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
        return new vscode.DebugAdapterInlineImplementation(
            new MicroPythonDebugSession() as unknown as vscode.DebugAdapter);
    }
}

class ConfigProvider implements vscode.DebugConfigurationProvider {
    /**
     * Fills in a usable configuration when the user presses F5 with no
     * launch.json, so the first run needs no setup.
     */
    resolveDebugConfiguration(
        folder: vscode.WorkspaceFolder | undefined,
        config: vscode.DebugConfiguration,
    ): vscode.ProviderResult<vscode.DebugConfiguration> {
        if (!config.type && !config.request && !config.name) {
            const editor = vscode.window.activeTextEditor;
            const active = editor?.document.languageId === "python"
                ? editor.document.fileName
                : undefined;
            const program = chooseProgram(folder?.uri.fsPath, active);
            if (!program) {
                void vscode.window.showErrorMessage(
                    "No main.py in this folder. Open the Python file to run, or "
                    + "create a launch configuration.");
                return undefined;
            }
            config.type = "micropython";
            config.name = "MicroPython Deploy and Debug (USB)";
            config.request = "launch";
            config.program = program;
            config.sync = true;
        }
        if (!config.program) {
            const root = folder?.uri.fsPath;
            if (root) {
                config.program = path.join(root, "main.py");
            }
        }
        return config;
    }
}

async function showDevices(): Promise<void> {
    const ports = await findPorts();
    if (!ports.debug) {
        void vscode.window.showWarningMessage(
            "No debug port found. The board must be running this MicroPython "
            + "firmware, which presents a second CDC interface for the debugger.");
        return;
    }
    void vscode.window.showInformationMessage(
        `Debug channel on ${ports.debug}`
        + (ports.repl ? `, REPL on ${ports.repl}` : ""));
}

/** Terminal on the board's REPL, reused if one is already open. */
let shellTerminal: vscode.Terminal | undefined;

async function openShell(): Promise<void> {
    shellTerminal = await openDeviceShell(shellTerminal);
}

/**
 * Run `fn` against a connected device, then always close the link.
 *
 * Every command here is a one-shot query, so none of them should leave a port
 * open -- a held port stops the next F5 from connecting, and the error that
 * causes says only that the device is busy.
 */
async function withDevice<T>(fn: (link: DeviceLink) => Promise<T>): Promise<T | undefined> {
    const ports = await findPorts();
    let debugPort = ports.debug;
    if (!debugPort) {
        debugPort = await offerFirmwareInstall();
    }
    if (!debugPort) {
        // The install offer above has already had the conversation: the user
        // declined, or the updater reported its own failure.  Adding an error
        // here would be answering "no" with a complaint.
        return undefined;
    }
    const link = new DeviceLink();
    try {
        await link.open(debugPort);
        return await fn(link);
    } catch (e) {
        void vscode.window.showErrorMessage((e as Error).message);
        return undefined;
    } finally {
        await link.close().catch(() => { /* already gone */ });
    }
}

/** Protocol version, limits and filesystem usage -- the first thing to ask for. */
async function showDeviceInfo(): Promise<void> {
    await withDevice(async (link) => {
        const caps = await link.capabilities();
        const st = await link.stat();
        const lines = [
            `protocol       v${caps.protocol}`,
            `breakpoints    ${caps.maxBreakpoints} max`,
            `payload        ${caps.maxPayload} bytes`,
            `value length   ${caps.maxValueLen} bytes`,
        ];
        if (st.rc === 0 && st.blockSize > 0) {
            const kb = (blocks: number) => Math.round(blocks * st.blockSize / 1024);
            lines.push(`filesystem     ${kb(st.free)} KB free of ${kb(st.total)} KB`);
        }
        output.appendLine("");
        output.appendLine("Device info:");
        lines.forEach((l) => output.appendLine("  " + l));
        output.show(true);
    });
}

/**
 * Remove every deployed .py and .mpy, leaving boot.py and any data files.
 *
 * boot.py is spared because it is the one file that can make a board unreachable
 * if it is wrong, so it is not this command's business to remove it silently.
 */
async function eraseDevice(): Promise<void> {
    const ok = await vscode.window.showWarningMessage(
        "Delete all deployed .py and .mpy files from the device?",
        { modal: true }, "Delete");
    if (ok !== "Delete") {
        return;
    }
    await withDevice(async (link) => {
        // A board halted at a breakpoint will not run far enough to notice.
        await link.setBreakpoints([]);
        await link.conditions(0, Cond.Stopped | Cond.Attached);

        let removed = 0;
        const walk = async (dir: string): Promise<void> => {
            let entries: { name: string; isDir: boolean }[];
            try {
                entries = await link.list(dir === "" ? "/" : dir);
            } catch {
                return;
            }
            for (const e of entries) {
                const full = dir === "" ? e.name : `${dir}/${e.name}`;
                if (e.isDir) {
                    await walk(full);
                } else if ((full.endsWith(".py") || full.endsWith(".mpy"))
                    && full !== "boot.py") {
                    if (await link.deleteFile(full) === 0) {
                        removed++;
                        output.appendLine(`removed ${full}`);
                    }
                }
            }
        };
        await walk("");
        await link.reboot(0);
        void vscode.window.showInformationMessage(
            `Removed ${removed} file${removed === 1 ? "" : "s"}; device restarted.`);
    });
}

// Deliberately free of board-specific modules: a new project must run on every
// board this debugger supports, and a template that raises ImportError on the
// user's first F5 is the worst possible introduction.
const SAMPLE_MAIN = [
    "# MicroPython debugger",
    "#",
    "# Press F5 to deploy this to the board and start debugging.",
    "# Click in the gutter beside a line number to set a breakpoint.",
    "#",
    "# Issues:  https://github.com/ghi-electronics/micropython-vsc-extension/issues",
    "# Support: support@ghielectronics.com",
    "# Website: www.ghielectronics.com",
    "",
    "import time",
    "",
    "",
    "def increment(cnt):",
    "    return cnt + 1",
    "",
    "",
    "count = 0",
    "while True:",
    "    count = increment(count)",
    "    print(\"count is\", count)",
    "    time.sleep_ms(500)",
    "",
].join("\n");

const SAMPLE_LAUNCH = {
    version: "0.2.0",
    configurations: [
        {
            type: "micropython",
            request: "launch",
            name: "MicroPython Deploy and Debug (USB)",
            program: "${workspaceFolder}/main.py",
            sync: true,
            stopOnEntry: false,
        },
    ],
};

/**
 * Scaffold a brand-new project: ask for the parent folder and a project name,
 * create the folder, write main.py + lib/ + .vscode/launch.json, then open it.
 *
 * "Open the folder" is what closes the wizard: since VS Code either reloads
 * the current window or opens a new one, code that runs after the openFolder
 * call may never execute here. The follow-up (focus main.py, show the ready
 * toast) is left as a breadcrumb in globalState and picked up by
 * openPendingProject() during activate in the destination window.
 */
const PENDING_KEY = "pendingProjectOpen";

async function newProject(context: vscode.ExtensionContext): Promise<void> {
    // Default the parent to the folder above the current workspace, so a
    // series of projects tend to land in one place. If nothing is open, the
    // user's home directory is as good a default as any.
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const defaultParent = workspaceRoot ? path.dirname(workspaceRoot) : os.homedir();

    const picked = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: "Select parent folder",
        defaultUri: vscode.Uri.file(defaultParent),
        title: "Where should the new MicroPython project live?",
    });
    if (!picked || picked.length === 0) {
        return;
    }
    const parent = picked[0].fsPath;

    const name = await vscode.window.showInputBox({
        title: "New MicroPython project",
        prompt: "Folder name for the new project",
        value: "micropython-project",
        // Restrict to characters that behave the same on Windows, macOS and
        // Linux filesystems, so a project made on one machine opens cleanly on
        // another. Spaces are allowed but trimmed.
        validateInput: (v) => {
            const trimmed = v.trim();
            if (!trimmed) {
                return "Enter a name.";
            }
            if (!/^[A-Za-z0-9 ._-]+$/.test(trimmed)) {
                return "Use only letters, digits, space, dot, underscore or hyphen.";
            }
            return null;
        },
    });
    if (!name) {
        return;
    }

    const root = path.join(parent, name.trim());

    if (fs.existsSync(root) && fs.readdirSync(root).length > 0) {
        const go = await vscode.window.showWarningMessage(
            `${root} already exists and is not empty.`,
            {
                modal: true,
                detail: "Files with the same names will be overwritten. "
                    + "Cancel and pick a different name to keep the existing folder.",
            },
            "Overwrite");
        if (go !== "Overwrite") {
            return;
        }
    }

    fs.mkdirSync(root, { recursive: true });
    // lib/ is on the device's sys.path, so anything dropped here imports by its
    // own name -- the shape third-party libraries expect.
    fs.mkdirSync(path.join(root, "lib"), { recursive: true });
    fs.writeFileSync(path.join(root, "main.py"), SAMPLE_MAIN, "utf8");
    writeLaunchJson(root);

    // Leave a breadcrumb so the extension in the destination window knows to
    // focus main.py and greet the user, rather than opening on a blank editor.
    await context.globalState.update(PENDING_KEY, root);

    // Open in a new window if the user already has one, so their current work
    // is not swept aside; reuse the empty window if they had nothing open.
    const uri = vscode.Uri.file(root);
    const forceNewWindow = !!vscode.workspace.workspaceFolders?.length;
    await vscode.commands.executeCommand("vscode.openFolder", uri, { forceNewWindow });
}

/**
 * When a "New Project" run set us up to open a fresh folder, finish the
 * wizard: focus main.py and show the ready toast. Runs once per creation --
 * the breadcrumb is cleared as soon as we act, and skipped if the destination
 * window is not the folder we were about to open (the user could have opened
 * something else in the meantime).
 */
async function openPendingProject(context: vscode.ExtensionContext): Promise<void> {
    const pending = context.globalState.get<string>(PENDING_KEY);
    if (!pending) {
        return;
    }
    const current = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!current || path.resolve(current) !== path.resolve(pending)) {
        return;                            // will be picked up when the right window opens
    }
    await context.globalState.update(PENDING_KEY, undefined);

    const mainPath = path.join(pending, "main.py");
    if (fs.existsSync(mainPath)) {
        try {
            const doc = await vscode.workspace.openTextDocument(mainPath);
            await vscode.window.showTextDocument(doc);
        } catch {
            // Not fatal -- the greeting still lands.
        }
    }
    void vscode.window.showInformationMessage(
        "Project ready. Press F5 to deploy and debug.");
}

/** Write .vscode/launch.json, leaving an existing one alone. */
function writeLaunchJson(root: string): boolean {
    const dir = path.join(root, ".vscode");
    const file = path.join(dir, "launch.json");
    if (fs.existsSync(file)) {
        return false;
    }
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(SAMPLE_LAUNCH, null, 4) + "\n", "utf8");
    return true;
}

/**
 * Offer a launch configuration after a session that ran without one.
 *
 * F5 works with no launch.json -- the configuration provider fills one in --
 * but VS Code then asks which debugger to use every single time, and that list
 * also offers debuggers that will happily run the file on the PC instead of the
 * board. One configuration removes both problems, so it is offered once per
 * folder and not nagged.
 *
 * There are two ways to be missing a configuration, and they need different
 * answers. With no launch.json, writing one is safe. With a launch.json that
 * has no MicroPython entry, it is not: the file is JSONC, and reading it in to
 * add an entry would strip the comments its author wrote. VS Code has no API
 * for appending a configuration, so this points at the snippet instead, which
 * inserts one block and leaves the rest of the file untouched.
 */
const launchJsonOffered = new Set<string>();

async function offerLaunchJson(session: vscode.DebugSession): Promise<void> {
    const folder = session.workspaceFolder;
    if (session.type !== "micropython" || !folder) {
        return;
    }
    const root = folder.uri.fsPath;
    if (launchJsonOffered.has(root)) {
        return;
    }

    // Ask VS Code, not the filesystem: a launch.json existing is not the same
    // as this debugger being configured in it, and conflating the two is what
    // leaves a project silently unable to reach the board on F5.
    const configured = hasMicroPythonConfig(
        vscode.workspace.getConfiguration("launch", folder.uri)
            .get("configurations"));
    if (configured) {
        return;
    }
    launchJsonOffered.add(root);

    const file = path.join(root, ".vscode", "launch.json");
    if (fs.existsSync(file)) {
        const answer = await vscode.window.showInformationMessage(
            "This project's launch.json has no MicroPython configuration, so F5 "
            + "will not start this debugger on its own. Add one with "
            + "\"Add Configuration...\".",
            "Open launch.json", "Not now");
        if (answer === "Open launch.json") {
            await vscode.window.showTextDocument(
                await vscode.workspace.openTextDocument(file));
        }
        return;
    }

    const answer = await vscode.window.showInformationMessage(
        "Save a launch configuration so F5 starts this debugger directly?",
        "Save", "Not now");
    if (answer === "Save" && writeLaunchJson(root)) {
        output.appendLine("wrote .vscode/launch.json");
    }
}
