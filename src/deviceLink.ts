/**
 * Transport to the device's debug channel (USB CDC1).
 *
 * Owns the serial port, matches replies to requests by sequence number, and
 * surfaces unsolicited device events (Execution_Stopped) as an EventEmitter
 * signal. Everything above this layer speaks in commands, not bytes.
 */
import { EventEmitter } from "events";
import { Decoder, build, Message } from "./wireProtocol";

// Loaded on first use, not at import time.  serialport is a native module; if
// it ever fails to load, that must surface as a clear error from the command
// that needed it rather than as a silent activation failure.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let serialportModule: any;
function serialport(): any {
    if (!serialportModule) {
        serialportModule = require("serialport");
    }
    return serialportModule;
}
import {
    Cmd, Cond, FileFlag, RebootFlag, StepMode, Scope,
    FLAG_NON_CRITICAL, FLAG_REPLY, MAX_PAYLOAD,
    USB_VID, USB_PID_CDC2, IFACE_REPL, IFACE_DEBUG,
} from "./protocol";

export interface StoppedEvent {
    reason: number;
    index: number;
    line: number;
    file: string;
}

export interface StackFrameInfo {
    file: string;
    line: number;
    func: string;
}

export interface DeviceVariable {
    name: string;
    value: string;
    /** Non-zero if expandable. Valid only while the device stays halted. */
    handle: number;
}

export interface DeviceCapabilities {
    protocol: number;
    maxBreakpoints: number;
    maxPayload: number;
    maxValueLen: number;
    /** Diagnostic: how many times the VM loop hook has run. */
    vmHookCalls: number;
}

export interface DevicePorts {
    repl?: string;
    debug?: string;
}

/**
 * Find the board's two CDC interfaces.
 *
 * Windows exposes the composite interface number in the port's pnpId as
 * "MI_00" / "MI_02"; on Linux and macOS the interface shows up in the path or
 * in `pnpId` differently, so both spellings are checked.
 */
export async function findPorts(): Promise<DevicePorts> {
    const ports = await serialport().SerialPort.list();
    const result: DevicePorts = {};
    for (const p of ports) {
        const vid = parseInt(p.vendorId ?? "", 16);
        const pid = parseInt(p.productId ?? "", 16);
        if (vid !== USB_VID || pid !== USB_PID_CDC2) {
            continue;
        }
        const id = (p.pnpId ?? "").toUpperCase();
        const iface = id.includes(`MI_0${IFACE_DEBUG}`) ? IFACE_DEBUG
            : id.includes(`MI_0${IFACE_REPL}`) ? IFACE_REPL
                : undefined;
        if (iface === IFACE_DEBUG) {
            result.debug = p.path;
        } else if (iface === IFACE_REPL) {
            result.repl = p.path;
        }
    }
    return result;
}

interface Pending {
    resolve: (m: Message) => void;
    reject: (e: Error) => void;
    timer: NodeJS.Timeout;
}

export class DeviceLink extends EventEmitter {
    private port?: any;
    /** Last transport error, for callers that want to report it. */
    lastError?: Error;
    private decoder = new Decoder();
    private pending = new Map<number, Pending>();
    private seq = 1;

    constructor() {
        super();
        // Node throws if an "error" event has no listener, so a serial error --
        // which happens routinely when the device resets and the port vanishes
        // under an open handle -- would take down the whole process, extension
        // host included. Record it and let interested callers listen as well.
        this.on("error", (e: Error) => {
            this.lastError = e;
        });
    }

    get isOpen(): boolean {
        return this.port?.isOpen ?? false;
    }

    async open(path: string): Promise<void> {
        await new Promise<void>((resolve, reject) => {
            // CDC ignores the baud rate -- this is USB, not a UART -- but the
            // API requires one.
            const port = new (serialport().SerialPort)(
                { path, baudRate: 115200 },
                (err: Error | null | undefined) => {
                if (err) {
                    reject(err);
                } else {
                    this.port = port;
                    resolve();
                }
            });
            port.on("data", (d: Buffer) => this.onData(d));
            port.on("error", (e: Error) => this.emit("error", e));
            port.on("close", () => this.emit("close"));
        });
    }

    async close(): Promise<void> {
        for (const [, p] of this.pending) {
            clearTimeout(p.timer);
            p.reject(new Error("link closed"));
        }
        this.pending.clear();
        const port = this.port;
        this.port = undefined;
        if (port?.isOpen) {
            await new Promise<void>((resolve) => port.close(() => resolve()));
        }
    }

    private onData(chunk: Buffer): void {
        for (const m of this.decoder.push(chunk)) {
            if ((m.flags & FLAG_REPLY) !== 0 && this.pending.has(m.seqReply)) {
                const p = this.pending.get(m.seqReply)!;
                this.pending.delete(m.seqReply);
                clearTimeout(p.timer);
                p.resolve(m);
            } else if (m.cmd === Cmd.ExecutionStopped) {
                this.emit("stopped", this.parseStopped(m));
            } else if (m.cmd === Cmd.MonitorOutput) {
                this.emit("output", m.payload.toString("utf8"));
            } else {
                this.emit("unsolicited", m);
            }
        }
    }

    private parseStopped(m: Message): StoppedEvent {
        const reason = m.payload.readUInt32LE(0);
        const index = m.payload.readUInt32LE(4);
        const line = m.payload.readUInt32LE(8);
        const fileLen = m.payload.readUInt16LE(12);
        const file = m.payload.subarray(14, 14 + fileLen).toString("utf8");
        return { reason, index, line, file };
    }

    /** Send a command and wait for its reply. */
    request(cmd: number, payload = Buffer.alloc(0), timeoutMs = 5000): Promise<Message> {
        if (!this.port?.isOpen) {
            return Promise.reject(new Error("device link is not open"));
        }
        const seq = this.seq++ & 0xffff;
        const frame = build(cmd, FLAG_NON_CRITICAL, payload, seq);

        return new Promise<Message>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(seq);
                reject(new Error(`device did not answer command 0x${cmd.toString(16)}`));
            }, timeoutMs);
            this.pending.set(seq, { resolve, reject, timer });
            try {
                this.port!.write(frame, (err: Error | null | undefined) => {
                    if (err) {
                        clearTimeout(timer);
                        this.pending.delete(seq);
                        reject(err);
                    }
                });
            } catch (e) {
                // The port can disappear between the isOpen check and the write
                // when the device resets.
                clearTimeout(timer);
                this.pending.delete(seq);
                reject(e as Error);
            }
        });
    }

    /**
     * Send without expecting a reply, resolving only once the bytes have
     * actually left the host.
     *
     * This must not be fire-and-forget. The one command that uses it is the
     * reboot, and the caller closes the port immediately afterwards: an
     * unflushed write is simply discarded, the device never resets, and the
     * session silently attaches to the still-running program instead. That
     * looks like "deploy did nothing" from the outside.
     */
    sendAndFlush(cmd: number, payload = Buffer.alloc(0)): Promise<void> {
        return new Promise<void>((resolve) => {
            const seq = this.seq++ & 0xffff;
            const frame = build(cmd, FLAG_NON_CRITICAL, payload, seq);
            if (!this.port?.isOpen) {
                resolve();
                return;
            }
            try {
                this.port.write(frame, () => {
                    // write() only queues; drain() waits for the OS to take it.
                    try {
                        this.port.drain(() => resolve());
                    } catch {
                        resolve();
                    }
                });
            } catch {
                resolve();
            }
        });
    }

    // ---------------------------------------------------------------- commands

    async ping(): Promise<boolean> {
        const p = Buffer.alloc(8);
        p.writeUInt32LE(1, 0);                   // source: host
        const r = await this.request(Cmd.MonitorPing, p, 2000);
        return r.valid;
    }

    /** Returns the device's condition bits after applying the change. */
    async conditions(set = 0, reset = 0): Promise<number> {
        const p = Buffer.alloc(8);
        p.writeUInt32LE(set >>> 0, 0);
        p.writeUInt32LE(reset >>> 0, 4);
        const r = await this.request(Cmd.ExecutionChangeConditions, p);
        return r.payload.readUInt32LE(0);
    }

    resume(): Promise<number> {
        return this.conditions(0, Cond.Stopped);
    }

    pause(): Promise<number> {
        return this.conditions(Cond.Stopped, 0);
    }

    async step(mode: StepMode): Promise<void> {
        const p = Buffer.alloc(4);
        p.writeUInt32LE(mode, 0);
        await this.request(Cmd.ExecutionStep, p);
        await this.resume();                     // a step implies resume
    }

    /**
     * Replace the whole breakpoint set. An empty file name matches any file.
     * The device caps the count; it returns how many it accepted.
     */
    async setBreakpoints(bps: { file: string; line: number }[]): Promise<number> {
        // Send as many as fit in one payload, not as many as the user set.
        // The device holds 16, but 16 long paths do not fit in 512 bytes, and
        // an oversized frame is dropped -- which would look like breakpoints
        // silently not working. Truncating here instead means the ones we do
        // send are the ones the device reports back, so the extras show up
        // unverified in the editor rather than vanishing.
        const parts: Buffer[] = [];
        const head = Buffer.alloc(2);
        parts.push(head);
        let size = 2;
        let sent = 0;
        for (const bp of bps) {
            const name = Buffer.from(bp.file, "utf8");
            const entry = 2 + name.length + 4;
            if (size + entry > MAX_PAYLOAD) {
                break;
            }
            const b = Buffer.alloc(entry);
            b.writeUInt16LE(name.length, 0);
            name.copy(b, 2);
            b.writeUInt32LE(bp.line, 2 + name.length);
            parts.push(b);
            size += entry;
            sent++;
        }
        head.writeUInt16LE(sent, 0);
        const r = await this.request(Cmd.ExecutionBreakpoints, Buffer.concat(parts));
        return r.payload.readInt32LE(0);
    }

    /**
     * Device limits. Asking beats assuming: the host sizes its requests from
     * these rather than hardcoding numbers that would silently drift if the
     * firmware changed.
     */
    async capabilities(): Promise<DeviceCapabilities> {
        const r = await this.request(Cmd.ExecutionCapabilities);
        return {
            protocol: r.payload.readUInt16LE(0),
            maxBreakpoints: r.payload.readUInt16LE(2),
            maxPayload: r.payload.readUInt16LE(4),
            maxValueLen: r.payload.readUInt16LE(6),
            vmHookCalls: r.payload.length >= 12 ? r.payload.readUInt32LE(8) : 0,
        };
    }

    async threads(): Promise<number> {
        const r = await this.request(Cmd.ThreadList);
        return r.payload.readUInt16LE(0);
    }

    async stack(): Promise<StackFrameInfo[]> {
        const r = await this.request(Cmd.ThreadStack);
        const p = r.payload;
        const count = p.readUInt16LE(0);
        let off = 2;
        const frames: StackFrameInfo[] = [];
        for (let i = 0; i < count; i++) {
            const line = p.readUInt32LE(off); off += 4;
            const fl = p.readUInt16LE(off); off += 2;
            const file = p.subarray(off, off + fl).toString("utf8"); off += fl;
            const nl = p.readUInt16LE(off); off += 2;
            const func = p.subarray(off, off + nl).toString("utf8"); off += nl;
            frames.push({ file, line, func });
        }
        return frames;
    }

    /**
     * Reboot the device. With WaitForDebugger it halts before the first
     * bytecode of main.py.
     *
     * From an idle REPL this is a hard reset, so USB re-enumerates and the
     * caller must reconnect. The device detaches USB first so the host sees a
     * real disconnect.
     */
    async reboot(flags: RebootFlag): Promise<void> {
        const p = Buffer.alloc(4);
        p.writeUInt32LE(flags >>> 0, 0);
        await this.sendAndFlush(Cmd.MonitorReboot, p);
        // The device acknowledges, waits ~50 ms, detaches USB and resets. Give
        // it that window before the port is closed under it.
        await new Promise((r) => setTimeout(r, 250));
    }

    /** Push a file, chunked to fit MAX_PAYLOAD. Returns 0 on success. */
    async putFile(name: string, data: Buffer): Promise<number> {
        const nameBuf = Buffer.from(name, "utf8");
        const chunkMax = MAX_PAYLOAD - 8 - nameBuf.length - 16;   // headroom
        let sent = 0;
        let first = true;
        while (sent < data.length || first) {
            const chunk = data.subarray(sent, sent + chunkMax);
            let flags = first ? FileFlag.First : 0;
            if (sent + chunk.length >= data.length) {
                flags |= FileFlag.Last;
            }
            const head = Buffer.alloc(8);
            head.writeUInt32LE(flags, 0);
            head.writeUInt16LE(nameBuf.length, 4);
            head.writeUInt16LE(chunk.length, 6);
            const r = await this.request(Cmd.FilePut,
                Buffer.concat([head, nameBuf, chunk]), 10000);
            const rc = r.payload.readInt32LE(0);
            if (rc !== 0) {
                return rc;
            }
            sent += chunk.length;
            first = false;
        }
        return 0;
    }

    /**
     * Decode a paginated variable reply:
     *   uint16 count, uint16 more, then count entries.
     *
     * Scopes and container children share this encoding, so one decoder
     * serves both. `handle` is non-zero for something worth expanding; it is
     * the device's variablesReference and is valid only until execution
     * resumes.
     */
    private decodeVars(b: Buffer): { vars: DeviceVariable[]; more: boolean } {
        const count = b.readUInt16LE(0);
        const more = b.readUInt16LE(2) !== 0;
        let off = 4;
        const vars: DeviceVariable[] = [];
        for (let i = 0; i < count; i++) {
            const nl = b.readUInt16LE(off); off += 2;
            const name = b.subarray(off, off + nl).toString("utf8"); off += nl;
            const vl = b.readUInt16LE(off); off += 2;
            const value = b.subarray(off, off + vl).toString("utf8"); off += vl;
            const handle = b.readUInt32LE(off); off += 4;
            vars.push({ name, value, handle });
        }
        return { vars, more };
    }

    /**
     * Keep asking until the device says there is nothing more.
     *
     * A reply has to fit one packet, so a module with many globals or one long
     * value arrives in pieces. Bounded so a device that always claims "more"
     * cannot spin here forever.
     */
    private async paged(
        fetch: (start: number) => Promise<Buffer>,
    ): Promise<DeviceVariable[]> {
        const out: DeviceVariable[] = [];
        for (let page = 0; page < 64; page++) {
            const { vars, more } = this.decodeVars(await fetch(out.length));
            out.push(...vars);
            if (!more || vars.length === 0) {
                break;
            }
        }
        return out;
    }

    /** Variables in a scope of a frame. Only globals are populated today. */
    variables(frame: number, scope: Scope): Promise<DeviceVariable[]> {
        return this.paged(async (start) => {
            const p = Buffer.alloc(12);
            p.writeUInt32LE(frame, 0);
            p.writeUInt32LE(scope, 4);
            p.writeUInt32LE(start, 8);
            return (await this.request(Cmd.ValueGetScope, p)).payload;
        });
    }

    /** Children of a container, addressed by the handle it was listed with. */
    children(handle: number): Promise<DeviceVariable[]> {
        return this.paged(async (start) => {
            const p = Buffer.alloc(8);
            p.writeUInt32LE(handle, 0);
            p.writeUInt32LE(start, 4);
            return (await this.request(Cmd.ValueGetChildren, p)).payload;
        });
    }

    /**
     * Evaluate an expression in a frame's context. Returns the repr, or the
     * exception's repr with ok=false -- "NameError: ..." is more useful to
     * show than a generic failure.
     */
    async evaluate(frame: number, expr: string): Promise<{ ok: boolean; value: string }> {
        const e = Buffer.from(expr, "utf8");
        const p = Buffer.alloc(6 + e.length);
        p.writeUInt32LE(frame, 0);
        p.writeUInt16LE(e.length, 4);
        e.copy(p, 6);
        const r = await this.request(Cmd.ValueEvaluate, p);
        const rc = r.payload.readInt32LE(0);
        const len = r.payload.readUInt16LE(4);
        return { ok: rc === 0, value: r.payload.subarray(6, 6 + len).toString("utf8") };
    }

    /**
     * Assign to a global in a frame's context. Returns the value the device
     * holds afterwards, read back rather than echoed.
     */
    async setVariable(frame: number, name: string, expr: string):
        Promise<{ ok: boolean; value: string }> {
        const n = Buffer.from(name, "utf8");
        const e = Buffer.from(expr, "utf8");
        const p = Buffer.alloc(8 + n.length + e.length);
        p.writeUInt32LE(frame, 0);
        p.writeUInt16LE(n.length, 4);
        n.copy(p, 6);
        p.writeUInt16LE(e.length, 6 + n.length);
        e.copy(p, 8 + n.length);
        const r = await this.request(Cmd.ValueSetVariable, p);
        const rc = r.payload.readInt32LE(0);
        const len = r.payload.readUInt16LE(4);
        return { ok: rc === 0, value: r.payload.subarray(6, 6 + len).toString("utf8") };
    }

    /** One directory's entries. Paginated like the variable commands. */
    async list(dir: string): Promise<{ name: string; isDir: boolean }[]> {
        const out: { name: string; isDir: boolean }[] = [];
        for (let page = 0; page < 64; page++) {
            const nb = Buffer.from(dir, "utf8");
            const p = Buffer.alloc(2 + nb.length + 4);
            p.writeUInt16LE(nb.length, 0);
            nb.copy(p, 2);
            p.writeUInt32LE(out.length, 2 + nb.length);
            const b = (await this.request(Cmd.FileList, p, 10000)).payload;
            if (b.length < 4) {
                break;
            }
            const count = b.readUInt16LE(0);
            const more = b.readUInt16LE(2) !== 0;
            let off = 4;
            for (let i = 0; i < count; i++) {
                const nl = b.readUInt16LE(off); off += 2;
                const name = b.subarray(off, off + nl).toString("utf8"); off += nl;
                const isDir = b[off] !== 0; off += 1;
                out.push({ name, isDir });
            }
            if (!more || count === 0) {
                break;
            }
        }
        return out;
    }

    /** Remove a file from the device. Returns 0 on success. */
    async deleteFile(name: string): Promise<number> {
        const nameBuf = Buffer.from(name, "utf8");
        const p = Buffer.alloc(2 + nameBuf.length);
        p.writeUInt16LE(nameBuf.length, 0);
        nameBuf.copy(p, 2);
        const r = await this.request(Cmd.FileDelete, p, 10000);
        return r.payload.readInt32LE(0);
    }

    /** Create a directory. Succeeds if it already exists. */
    async mkdir(name: string): Promise<number> {
        const nameBuf = Buffer.from(name, "utf8");
        const p = Buffer.alloc(2 + nameBuf.length);
        p.writeUInt16LE(nameBuf.length, 0);
        nameBuf.copy(p, 2);
        const r = await this.request(Cmd.FileMkdir, p, 10000);
        return r.payload.readInt32LE(0);
    }

    /** Device-side CRC and size, so unchanged files can be skipped. */
    async fileCrc(name: string): Promise<{ rc: number; crc: number; size: number }> {
        const nameBuf = Buffer.from(name, "utf8");
        const p = Buffer.alloc(2 + nameBuf.length);
        p.writeUInt16LE(nameBuf.length, 0);
        nameBuf.copy(p, 2);
        const r = await this.request(Cmd.FileCrc, p, 10000);
        return {
            rc: r.payload.readInt32LE(0),
            crc: r.payload.readUInt32LE(4),
            size: r.payload.readUInt32LE(8),
        };
    }
}
