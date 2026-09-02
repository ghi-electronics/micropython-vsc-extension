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
        this.writeEmitter.fire(`Connecting to ${this.path}...\r\n`);
        try {
            this.port = new (serialport().SerialPort)(
                { path: this.path, baudRate: 115200 },
                (err: Error | null | undefined) => {
                    if (err) {
                        this.writeEmitter.fire(`\r\nCould not open ${this.path}: ${err.message}\r\n`);
                        this.closeEmitter.fire(1);
                        return;
                    }
                    // Ctrl-B leaves the raw REPL if something left it there, and
                    // a bare newline draws the prompt so the terminal is not
                    // blank until the user types.
                    this.port.write("\x02\r\n");
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
                ? "Found the debug port but not the REPL port. The board must be in VCP+VCP mode."
                : "No SITCore device found.");
        return undefined;
    }

    const terminal = vscode.window.createTerminal({
        name: "MicroPython REPL",
        pty: new ReplPty(ports.repl),
    });
    terminal.show();
    return terminal;
}
