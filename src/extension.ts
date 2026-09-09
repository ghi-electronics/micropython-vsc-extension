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
import { MicroPythonDebugSession } from "./debugSession";
import { DeviceLink, findPorts } from "./deviceLink";
import { Cond } from "./protocol";
import { openDeviceShell } from "./replTerminal";
import { updateFirmware, flashFromFile } from "./firmware/updateFirmware";
import { offerFirmwareInstall } from "./firmware/notInstalled";

const output = vscode.window.createOutputChannel("MicroPython Debugger");

export function activate(context: vscode.ExtensionContext): void {
    output.appendLine("MicroPython Debugger extension activated");
    context.subscriptions.push(output);
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
            "micropython-debugger.newProject", () => { void newProject(); }),
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
            if (editor?.document.languageId !== "python") {
                void vscode.window.showErrorMessage(
                    "Open a Python file, or create a launch configuration.");
                return undefined;
            }
            config.type = "micropython";
            config.name = "Deploy and Debug (MicroPython, USB)";
            config.request = "launch";
            config.program = editor.document.fileName;
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
        void vscode.window.showErrorMessage(
            "No debug port found. The board must be running this MicroPython firmware.");
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
    "# MicroPython.",
    "#",
    "# Press F5 to deploy this to the board and start debugging.",
    "# Click in the gutter beside a line number to set a breakpoint.",
    "",
    "import time",
    "",
    "",
    "def blink(count):",
    "    total = count + 1",
    "    return total",
    "",
    "",
    "count = 0",
    "while True:",
    "    count = blink(count)",
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
            name: "Deploy and Debug (MicroPython, USB)",
            program: "${workspaceFolder}/main.py",
            sync: true,
            stopOnEntry: false,
        },
    ],
};

/**
 * Scaffold an empty folder: an entry script, a lib/ for modules, and a launch
 * configuration. Only useful when starting from nothing -- an existing project
 * already runs with F5 and needs none of this.
 */
async function newProject(): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
        void vscode.window.showErrorMessage("Open a folder first.");
        return;
    }
    const root = folder.uri.fsPath;
    const mainPath = path.join(root, "main.py");
    if (fs.existsSync(mainPath)) {
        const go = await vscode.window.showWarningMessage(
            "main.py already exists. Add the launch configuration and lib/ only?",
            "Continue", "Cancel");
        if (go !== "Continue") {
            return;
        }
    } else {
        fs.writeFileSync(mainPath, SAMPLE_MAIN, "utf8");
    }

    // lib/ is on the device's sys.path, so anything dropped here imports by its
    // own name -- the shape third-party libraries expect.
    fs.mkdirSync(path.join(root, "lib"), { recursive: true });
    writeLaunchJson(root);

    const doc = await vscode.workspace.openTextDocument(mainPath);
    await vscode.window.showTextDocument(doc);
    void vscode.window.showInformationMessage("Project ready. Press F5 to deploy and debug.");
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
 * Offer to save a launch configuration after a session that ran without one.
 *
 * F5 works with no launch.json -- the configuration provider fills one in -- but
 * VS Code then asks which debugger to use every single time, and that list also
 * offers debuggers that will happily run the file on the PC instead of the
 * board. One file removes both problems, so it is offered once and not nagged.
 */
let launchJsonOffered = false;

async function offerLaunchJson(session: vscode.DebugSession): Promise<void> {
    if (session.type !== "micropython" || launchJsonOffered) {
        return;
    }
    const root = session.workspaceFolder?.uri.fsPath;
    if (!root || fs.existsSync(path.join(root, ".vscode", "launch.json"))) {
        return;
    }
    launchJsonOffered = true;
    const answer = await vscode.window.showInformationMessage(
        "Save a launch configuration so F5 starts this debugger directly?",
        "Save", "Not now");
    if (answer === "Save" && writeLaunchJson(root)) {
        output.appendLine("wrote .vscode/launch.json");
    }
}
