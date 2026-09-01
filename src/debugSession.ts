/**
 * DAP <-> device translation.
 *
 * Every DAP request here maps onto one device command; the device side was
 * built to make that mapping direct (Thread_Stack already returns frames
 * innermost-first, which is the order stackTrace wants, and Execution_Stopped
 * already carries a DAP-shaped reason).
 */
import {
    DebugSession, InitializedEvent, StoppedEvent, TerminatedEvent,
    OutputEvent, Thread, StackFrame, Source, Scope,
} from "@vscode/debugadapter";
import { DebugProtocol } from "@vscode/debugprotocol";
import * as path from "path";
import * as fs from "fs";
import { DeviceLink, findPorts, StackFrameInfo } from "./deviceLink";
import { Cond, RebootFlag, StepMode, StopReason, STOP_REASON_TO_DAP, Scope as DevScope } from "./protocol";
import { crc32 } from "./wireProtocol";

interface LaunchArgs extends DebugProtocol.LaunchRequestArguments {
    program: string;
    sync?: boolean;
    device?: string;
    stopOnEntry?: boolean;
}

/** The device is single-threaded; DAP still requires a thread id. */
const THREAD_ID = 1;

/** variablesReference must be non-zero; frame index is encoded above this. */
const VARREF_GLOBALS_BASE = 1000;

export class MicroPythonDebugSession extends DebugSession {
    private link = new DeviceLink();
    private programDir = "";
    private breakpoints = new Map<string, number[]>();
    private frames: StackFrameInfo[] = [];
    private stopOnEntry = false;
    private configurationDone = false;

    public constructor() {
        super();
        this.setDebuggerLinesStartAt1(true);
        this.setDebuggerColumnsStartAt1(true);
    }

    protected initializeRequest(
        response: DebugProtocol.InitializeResponse,
        _args: DebugProtocol.InitializeRequestArguments,
    ): void {
        response.body = response.body || {};
        response.body.supportsConfigurationDoneRequest = true;
        response.body.supportsTerminateRequest = true;
        // Deliberately not advertised until milestone 6: claiming these and
        // returning nothing produces a worse experience than not claiming them.
        response.body.supportsEvaluateForHovers = false;
        response.body.supportsSetVariable = false;
        this.sendResponse(response);
    }

    protected configurationDoneRequest(
        response: DebugProtocol.ConfigurationDoneResponse,
        args: DebugProtocol.ConfigurationDoneArguments,
    ): void {
        super.configurationDoneRequest(response, args);
        this.configurationDone = true;
        // Breakpoints are in place now, which is the whole reason the device
        // halts before the first bytecode (section 7.1). Release it.
        if (!this.stopOnEntry) {
            void this.link.resume();
        } else {
            this.sendEvent(new StoppedEvent("entry", THREAD_ID));
        }
    }

    protected async launchRequest(
        response: DebugProtocol.LaunchResponse,
        args: LaunchArgs,
    ): Promise<void> {
        try {
            this.stopOnEntry = args.stopOnEntry ?? false;
            this.programDir = path.dirname(args.program);

            const ports = await findPorts();
            const devicePort = args.device || ports.debug;
            if (!devicePort) {
                throw new Error(
                    "No SITCore debug port found. The board must be running MicroPython "
                    + "with two CDC interfaces (VCP+VCP).");
            }
            await this.link.open(devicePort);
            this.attachEvents();

            if (args.sync !== false) {
                await this.syncWorkspace(args.program);
            }

            // Reboot into a halt so breakpoints can be set before anything runs.
            this.log("Restarting device...");
            this.link.reboot(RebootFlag.WaitForDebugger);
            await this.link.close();
            await delay(1200);
            await this.reconnect(args.device);
            await this.link.conditions(Cond.Attached, 0);

            this.sendResponse(response);
            // Only now does VS Code send setBreakpoints, then configurationDone.
            this.sendEvent(new InitializedEvent());
        } catch (err) {
            this.sendErrorResponse(response, 1001, (err as Error).message);
        }
    }

    /** Push .py files whose device-side CRC does not match, and nothing else. */
    private async syncWorkspace(program: string): Promise<void> {
        const dir = path.dirname(program);
        let names: string[];
        try {
            names = fs.readdirSync(dir).filter((n) => n.endsWith(".py"));
        } catch {
            names = [];
        }
        // The entry script is always pushed as main.py, which is what the
        // device runs on boot.
        const entry = path.basename(program);
        for (const name of names) {
            const data = fs.readFileSync(path.join(dir, name));
            const target = name === entry ? "main.py" : name;
            const info = await this.link.fileCrc(target);
            if (info.rc === 0 && info.size === data.length && info.crc === crc32(data)) {
                this.log(`unchanged  ${target}`);
                continue;
            }
            const rc = await this.link.putFile(target, data);
            this.log(rc === 0 ? `pushed     ${target} (${data.length} bytes)`
                : `FAILED     ${target} (${rc})`);
        }
    }

    private async reconnect(preferred?: string): Promise<void> {
        for (let i = 0; i < 40; i++) {
            const ports = await findPorts();
            const p = preferred || ports.debug;
            if (p) {
                try {
                    await this.link.open(p);
                    this.attachEvents();
                    await delay(300);
                    return;
                } catch { /* still enumerating */ }
            }
            await delay(500);
        }
        throw new Error("Device did not come back after reset.");
    }

    private attachEvents(): void {
        this.link.removeAllListeners("stopped");
        this.link.removeAllListeners("output");
        // Program output arrives as its own event. "stdout" categorises it as
        // the program's, distinct from the adapter's own "console" messages.
        this.link.on("output", (text: string) => {
            this.sendEvent(new OutputEvent(text, "stdout"));
        });
        this.link.on("stopped", (ev) => {
            if (ev.reason === StopReason.Exited) {
                this.sendEvent(new TerminatedEvent());
                return;
            }
            if (ev.reason === StopReason.Entry && !this.configurationDone) {
                // Expected: we asked it to halt here. Not a user-visible stop.
                return;
            }
            const reason = STOP_REASON_TO_DAP[ev.reason] ?? "pause";
            this.sendEvent(new StoppedEvent(reason, THREAD_ID));
        });
    }

    protected async setBreakPointsRequest(
        response: DebugProtocol.SetBreakpointsResponse,
        args: DebugProtocol.SetBreakpointsArguments,
    ): Promise<void> {
        const file = args.source.path ? path.basename(args.source.path) : "";
        const lines = (args.breakpoints ?? []).map((b) => b.line);
        this.breakpoints.set(file, lines);

        const all: { file: string; line: number }[] = [];
        for (const [f, ls] of this.breakpoints) {
            for (const l of ls) {
                all.push({ file: f === path.basename(this.programEntry()) ? "main.py" : f, line: l });
            }
        }
        let accepted = 0;
        try {
            accepted = await this.link.setBreakpoints(all);
        } catch (e) {
            this.log(`breakpoints: ${(e as Error).message}`);
        }
        // The device caps how many breakpoints it will hold (8). Report which
        // ones are actually in force rather than claiming all of them: VS Code
        // greys out unverified breakpoints, which is the truth the user needs.
        response.body = {
            breakpoints: lines.map((line, i) => ({ verified: i < accepted, line })),
        };
        this.sendResponse(response);
    }

    private programEntry(): string {
        return path.join(this.programDir, "main.py");
    }

    protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
        response.body = { threads: [new Thread(THREAD_ID, "main")] };
        this.sendResponse(response);
    }

    protected async stackTraceRequest(
        response: DebugProtocol.StackTraceResponse,
        _args: DebugProtocol.StackTraceArguments,
    ): Promise<void> {
        try {
            this.frames = await this.link.stack();
        } catch {
            this.frames = [];
        }
        response.body = {
            stackFrames: this.frames.map((f, i) => new StackFrame(
                i,
                f.func === "<module>" ? "(module)" : `${f.func}()`,
                this.sourceFor(f.file),
                f.line,
            )),
            totalFrames: this.frames.length,
        };
        this.sendResponse(response);
    }

    /**
     * The device reports the name it loaded the module under ("main.py"), not
     * the editor's path, so map it back into the workspace.
     */
    private sourceFor(deviceFile: string): Source {
        const local = path.join(this.programDir, deviceFile);
        return new Source(deviceFile, fs.existsSync(local) ? local : undefined);
    }

    protected scopesRequest(
        response: DebugProtocol.ScopesResponse,
        args: DebugProtocol.ScopesArguments,
    ): void {
        // Only globals. Local variable names are not recoverable in upstream
        // MicroPython -- the bytecode prelude has no slot-to-identifier map --
        // so a Locals scope would list values with no names, which is worse
        // than not offering it. See micropython_debugger.md 2.2 and 9.2.
        //
        // The reference encodes the frame index, so a scope request against an
        // outer frame reads that frame's module globals.
        response.body = {
            scopes: [new Scope("Globals", VARREF_GLOBALS_BASE + args.frameId, true)],
        };
        this.sendResponse(response);
    }

    protected async variablesRequest(
        response: DebugProtocol.VariablesResponse,
        args: DebugProtocol.VariablesArguments,
    ): Promise<void> {
        const frame = args.variablesReference - VARREF_GLOBALS_BASE;
        let vars: { name: string; value: string }[] = [];
        try {
            vars = await this.link.variables(frame, DevScope.Globals);
        } catch (e) {
            this.log(`variables: ${(e as Error).message}`);
        }
        response.body = {
            variables: vars.map((v) => ({
                name: v.name,
                value: v.value,
                variablesReference: 0,          // no expansion yet
            })),
        };
        this.sendResponse(response);
    }

    protected async continueRequest(
        response: DebugProtocol.ContinueResponse,
    ): Promise<void> {
        await this.link.resume();
        this.sendResponse(response);
    }

    protected async pauseRequest(response: DebugProtocol.PauseResponse): Promise<void> {
        await this.link.pause();
        this.sendResponse(response);
    }

    protected async nextRequest(response: DebugProtocol.NextResponse): Promise<void> {
        await this.link.step(StepMode.Over);
        this.sendResponse(response);
    }

    protected async stepInRequest(response: DebugProtocol.StepInResponse): Promise<void> {
        await this.link.step(StepMode.In);
        this.sendResponse(response);
    }

    protected async stepOutRequest(response: DebugProtocol.StepOutResponse): Promise<void> {
        await this.link.step(StepMode.Out);
        this.sendResponse(response);
    }

    protected async disconnectRequest(
        response: DebugProtocol.DisconnectResponse,
    ): Promise<void> {
        try {
            await this.link.setBreakpoints([]);
            await this.link.conditions(0, Cond.Stopped | Cond.Attached);
        } catch { /* the device may already be gone */ }
        await this.link.close();
        this.sendResponse(response);
    }

    private log(msg: string): void {
        this.sendEvent(new OutputEvent(msg + "\n", "console"));
    }
}

function delay(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}
