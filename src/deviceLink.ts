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
    Cmd, Cond, FileFlag, RebootFlag, StepMode,
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
    private decoder = new Decoder();
    private pending = new Map<number, Pending>();
    private seq = 1;

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
            this.port!.write(frame, (err: Error | null | undefined) => {
                if (err) {
                    clearTimeout(timer);
                    this.pending.delete(seq);
                    reject(err);
                }
            });
        });
    }

    /** Fire and forget -- used where a reply cannot arrive (the device is resetting). */
    send(cmd: number, payload = Buffer.alloc(0)): void {
        const seq = this.seq++ & 0xffff;
        this.port?.write(build(cmd, FLAG_NON_CRITICAL, payload, seq));
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
        const parts: Buffer[] = [];
        const head = Buffer.alloc(2);
        head.writeUInt16LE(bps.length, 0);
        parts.push(head);
        for (const bp of bps) {
            const name = Buffer.from(bp.file, "utf8");
            const b = Buffer.alloc(2 + name.length + 4);
            b.writeUInt16LE(name.length, 0);
            name.copy(b, 2);
            b.writeUInt32LE(bp.line, 2 + name.length);
            parts.push(b);
        }
        const r = await this.request(Cmd.ExecutionBreakpoints, Buffer.concat(parts));
        return r.payload.readInt32LE(0);
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
    reboot(flags: RebootFlag): void {
        const p = Buffer.alloc(4);
        p.writeUInt32LE(flags >>> 0, 0);
        this.send(Cmd.MonitorReboot, p);
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

    /** Remove a file from the device. Returns 0 on success. */
    async deleteFile(name: string): Promise<number> {
        const nameBuf = Buffer.from(name, "utf8");
        const p = Buffer.alloc(2 + nameBuf.length);
        p.writeUInt16LE(nameBuf.length, 0);
        nameBuf.copy(p, 2);
        const r = await this.request(Cmd.FileDelete, p, 10000);
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
