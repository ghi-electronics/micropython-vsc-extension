/**
 * The device's REPL, in a VS Code terminal.
 *
 * The board exposes two CDC interfaces: the debugger owns the second, and the
 * REPL keeps the first entirely to itself. So this works *while a debug session
 * is running* -- including while the program is stopped at a breakpoint. You can
 * read a pin, try an expression, or check a register without disturbing the
 * halt, because the two channels never touch each other.
 *
 * A pseudoterminal rather than a spawned process: there is no external tool to
 * shell out to, and nothing to install.
 */
import * as vscode from "vscode";
import { findPorts } from "./deviceLink";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let serialportModule: any;
function serialport(): any {
    if (!serialportModule) {
        serialportModule = require("serialport");
    }
    return serialportModule;
}

class ReplPty implements vscode.Pseudoterminal {
    private writeEmitter = new vscode.EventEmitter<string>();
    private closeEmitter = new vscode.EventEmitter<number | void>();
    readonly onDidWrite = this.writeEmitter.event;
    readonly onDidClose = this.closeEmitter.event;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private port?: any;

    constructor(private readonly path: string) { }

    open(): void {
        // Dim, so the note reads as ours rather than as device output.
        const dim = (t: string) => `\x1b[2m${t}\x1b[0m\r\n`;
        this.writeEmitter.fire(dim(`Device console on ${this.path}`));
        this.writeEmitter.fire(dim(
            "Program output appears here. Press Ctrl-C to stop the program and get a >>> prompt."));
        try {
            this.port = new (serialport().SerialPort)(
                { path: this.path, baudRate: 115200 },
                (err: Error | null | undefined) => {
                    if (err) {
                        this.writeEmitter.fire(`\r\nCould not open ${this.path}: ${err.message}\r\n`);
                        this.closeEmitter.fire(1);
                        return;
                    }
                    // Nothing is sent on connect. A newline would only draw a
                    // prompt if the REPL happened to be listening, and a control
                    // byte sent blindly shows up as a stray glyph when it is not.
                });
        } catch (e) {
            this.writeEmitter.fire(`\r\n${(e as Error).message}\r\n`);
            this.closeEmitter.fire(1);
            return;
        }

        this.port.on("data", (d: Buffer) => this.writeEmitter.fire(d.toString("utf8")));
        this.port.on("error", (e: Error) => {
            this.writeEmitter.fire(`\r\n[${e.message}]\r\n`);
        });
        this.port.on("close", () => {
            this.writeEmitter.fire("\r\n[device disconnected]\r\n");
            this.closeEmitter.fire(0);
        });
    }

    close(): void {
        try {
            if (this.port?.isOpen) {
                this.port.close();
            }
        } catch { /* already gone */ }
    }

    handleInput(data: string): void {
        // VS Code sends "\r" for Enter; MicroPython's REPL wants that as-is.
        try {
            this.port?.write(data);
        } catch { /* port closed under us */ }
    }
}

/** Open a terminal on the board's REPL, reusing one if it is already open. */
export async function openDeviceShell(existing?: vscode.Terminal): Promise<vscode.Terminal | undefined> {
    if (existing && existing.exitStatus === undefined) {
        existing.show();
        return existing;
    }

    const ports = await findPorts();
    if (!ports.repl) {
        void vscode.window.showErrorMessage(
            ports.debug
                ? "Found the debug port but not the REPL port."
                : "No supported device found.");
        return undefined;
    }

    const terminal = vscode.window.createTerminal({
        name: "MicroPython REPL",
        pty: new ReplPty(ports.repl),
    });
    terminal.show();
    return terminal;
}
