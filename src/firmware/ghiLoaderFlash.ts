// Copyright (c) GHI Electronics.
// SPDX-License-Identifier: MIT

/**
 * Flashing a GHI SITCore board through its BL2 bootloader.
 *
 * The bootloader is a single-CDC serial device that speaks a tiny CR/LF
 * command line plus XMODEM-1K for the payload.  Same wire pattern across the
 * whole BL2 family (SC13xxx today, SC20xxx and Scorexxx later): only the VID
 * matters, since the .ghi file's encrypted header carries device-specific
 * regions and the bootloader validates and decrypts it before flashing.
 *
 * Command exchange (from tinyclr/bootloader.md, verified against BL2 source):
 *
 *     Host: V\r           --> bootloader banner ending in "OK.\r\n"
 *     Host: X\r           --> "Are you sure (Y/N)?\r\n"
 *     Host: Y\r           --> "Waiting...\r\n" then a stream of 'C' characters
 *     Host: [1K XMODEM]   --> STX-framed 1024-byte blocks, CRC-16-XMODEM
 *                             The X command's first-packet processing erases
 *                             the target flash region from the encrypted
 *                             header, so no separate E command is needed.
 *     Host: R\r           --> jump to firmware
 *
 * **Line terminator is a single \r, not \r\n.**  The bootloader's IO_ReadLine
 * ends on the first \r OR \n it sees; sending both makes the trailing \n look
 * like an empty command line and cancels whatever confirmation the previous
 * command was waiting for.
 *
 * The `B` command (raise UART baud to 921,600) is deliberately not sent: this
 * is a USB-CDC device, so its "baud" is fiction and B costs a round trip for
 * nothing.  One less state to get wrong.
 */

import { EventEmitter } from "events";

// serialport loaded lazily, same reason espFlash and deviceLink do: it is a
// native module and a load failure has to surface from the command that
// needed it rather than break extension activation.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let serialportModule: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function serialport(): any {
    if (!serialportModule) {
        serialportModule = require("serialport");
    }
    return serialportModule;
}

// XMODEM frame bytes.
const SOH = 0x01;                    // 128-byte packet (unused here, kept for reference)
const STX = 0x02;                    // 1024-byte packet
const EOT = 0x04;                    // end of transmission
const ACK = 0x06;
const NAK = 0x15;
const CAN = 0x18;
const CRC_MODE = 0x43;               // 'C' -- receiver ready in CRC mode

const XMODEM_PACKET_SIZE = 1024;
const XMODEM_PAD_BYTE = 0x1A;        // Ctrl-Z, standard XMODEM padding
const XMODEM_BLOCK_RETRIES = 10;
const XMODEM_EOT_RETRIES = 3;

// Command exchange timing.
const OPEN_TIMEOUT_MS = 3_000;
const BANNER_TIMEOUT_MS = 3_000;
const PROMPT_TIMEOUT_MS = 2_000;
const CRC_WAIT_TIMEOUT_MS = 15_000;  // bootloader sends "C" once it is ready
const BLOCK_ACK_TIMEOUT_MS = 5_000;
// First-block ACK is deliberately much longer: the bootloader receives the
// encrypted header in packet 1, then erases the target flash region before
// acking.  Full 384 KB region erase on STM32L4 takes ~15 s worst case, so
// 60 s is comfortable headroom.  Subsequent blocks ACK quickly.
const FIRST_BLOCK_ACK_TIMEOUT_MS = 60_000;

/** CRC-16/XMODEM (poly 0x1021, init 0, no reflection, no final XOR). */
function crc16xmodem(data: Uint8Array): number {
    let crc = 0;
    for (const b of data) {
        crc ^= (b << 8);
        for (let i = 0; i < 8; i++) {
            crc = (crc & 0x8000) ? (((crc << 1) ^ 0x1021) & 0xFFFF) : ((crc << 1) & 0xFFFF);
        }
    }
    return crc;
}

/**
 * FIFO of bytes arriving from the port. Reads await bytes with a timeout;
 * writes push whatever the port produced.
 *
 * Kept simple on purpose: the bootloader talks in short exchanges (a few
 * bytes each) and never streams so fast that back-pressure matters.
 */
class ByteQueue {
    private buf: Buffer = Buffer.alloc(0);
    private waiter: {
        resolve: (b: Buffer) => void;
        reject: (e: Error) => void;
        timer: NodeJS.Timeout;
    } | null = null;
    private lastError: Error | undefined;

    push(chunk: Buffer): void {
        if (this.waiter) {
            const w = this.waiter;
            this.waiter = null;
            clearTimeout(w.timer);
            w.resolve(chunk);
            return;
        }
        this.buf = Buffer.concat([this.buf, chunk]);
    }

    fail(e: Error): void {
        this.lastError = e;
        if (this.waiter) {
            const w = this.waiter;
            this.waiter = null;
            clearTimeout(w.timer);
            w.reject(e);
        }
    }

    /** Drain everything currently buffered without waiting. */
    drain(): Buffer {
        const out = this.buf;
        this.buf = Buffer.alloc(0);
        return out;
    }

    /** Wait until any bytes arrive (or the buffer already has some), with a timeout. */
    async read(timeoutMs: number): Promise<Buffer> {
        if (this.lastError) {
            throw this.lastError;
        }
        if (this.buf.length > 0) {
            return this.drain();
        }
        return new Promise<Buffer>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.waiter = null;
                reject(new Error("Timed out waiting for the bootloader"));
            }, timeoutMs);
            this.waiter = { resolve, reject, timer };
        });
    }

    /** Await one byte; -1 if no bytes are available within the timeout. */
    async readByte(timeoutMs: number): Promise<number> {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            try {
                const b = await this.read(deadline - Date.now());
                if (b.length > 0) {
                    if (b.length > 1) {
                        this.buf = Buffer.concat([b.subarray(1), this.buf]);
                    }
                    return b[0];
                }
            } catch {
                return -1;
            }
        }
        return -1;
    }

    /** Read until a matching regex is seen in the accumulated text, then return the run so far. */
    async readUntil(pattern: RegExp, timeoutMs: number): Promise<string> {
        const deadline = Date.now() + timeoutMs;
        let acc = this.drain().toString("latin1");
        for (;;) {
            if (pattern.test(acc)) {
                return acc;
            }
            const remaining = deadline - Date.now();
            if (remaining <= 0) {
                throw new Error(`Timed out waiting for pattern ${pattern}; got: ${acc.trimEnd()}`);
            }
            const chunk = await this.read(remaining);
            acc += chunk.toString("latin1");
        }
    }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function writePort(port: any, data: Uint8Array): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        port.write(Buffer.from(data), (err: Error | null | undefined) =>
            (err ? reject(err) : resolve()));
    });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function openPort(path: string): Promise<any> {
    const { SerialPort } = serialport();
    // CDC ignores baud rate on the wire, but the underlying OS driver still
    // wants a plausible number to open.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const port: any = new SerialPort({ path, baudRate: 115200, autoOpen: false });
    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(
            `Timed out opening ${path}. Another program may have it open -- ` +
            `close any serial monitor using that port.`)), OPEN_TIMEOUT_MS);
        port.open((err: Error | null) => {
            clearTimeout(timer);
            if (err) {
                reject(err);
            } else {
                resolve();
            }
        });
    });
    return port;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function closePort(port: any): Promise<void> {
    if (!port?.isOpen) {
        return;
    }
    await new Promise<void>((resolve) => port.close(() => resolve()));
}

/**
 * Send a single command (`X\r\n`) and read until the given pattern matches.
 * Returns the response text up to and including the match.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function sendCommand(port: any, queue: ByteQueue, cmd: string,
    expect: RegExp, timeoutMs: number): Promise<string> {
    await writePort(port, Buffer.from(cmd + "\r", "latin1"));
    return queue.readUntil(expect, timeoutMs);
}

/**
 * Wait for the bootloader to start sending 'C' -- its CRC-mode "send me the
 * first packet" signal.  It repeats "C" every ~1 s while it waits, so any
 * appearance means we can start sending; the loop just discards echo and any
 * confirmation text that may have preceded it.
 */
async function waitForCRC(queue: ByteQueue, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const b = await queue.readByte(deadline - Date.now());
        if (b === CRC_MODE) {
            return;
        }
        if (b === -1) {
            break;
        }
        // Anything else is the bootloader echoing the 'Y' or emitting text
        // ahead of the C stream; ignore it and keep looking.
    }
    throw new Error("Bootloader did not enter XMODEM receive mode");
}

/** Assemble one 1K XMODEM block: STX | seq | ~seq | 1024 bytes | CRC16 (big-endian). */
function buildBlock(seq: number, payload: Buffer): Buffer {
    const packet = Buffer.alloc(3 + XMODEM_PACKET_SIZE + 2);
    packet[0] = STX;
    packet[1] = seq & 0xFF;
    packet[2] = (~seq) & 0xFF;
    payload.copy(packet, 3);
    for (let i = payload.length; i < XMODEM_PACKET_SIZE; i++) {
        packet[3 + i] = XMODEM_PAD_BYTE;
    }
    const crc = crc16xmodem(packet.subarray(3, 3 + XMODEM_PACKET_SIZE));
    packet[3 + XMODEM_PACKET_SIZE] = (crc >> 8) & 0xFF;
    packet[3 + XMODEM_PACKET_SIZE + 1] = crc & 0xFF;
    return packet;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function sendBlock(port: any, queue: ByteQueue, seq: number, payload: Buffer,
    isFirstBlock: boolean): Promise<void> {
    const packet = buildBlock(seq, payload);
    const ackTimeout = isFirstBlock ? FIRST_BLOCK_ACK_TIMEOUT_MS : BLOCK_ACK_TIMEOUT_MS;
    for (let attempt = 0; attempt < XMODEM_BLOCK_RETRIES; attempt++) {
        await writePort(port, packet);
        const r = await queue.readByte(ackTimeout);
        if (r === ACK) {
            return;
        }
        if (r === CAN) {
            throw new Error("Bootloader cancelled the transfer");
        }
        // NAK or timeout: resend after a brief pause so the receiver's own
        // buffers clear.  10 retries is well past any transient glitch and
        // stops well short of a broken link keeping us here forever.
        await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`Block ${seq} was not acknowledged after ${XMODEM_BLOCK_RETRIES} tries`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function sendEot(port: any, queue: ByteQueue): Promise<void> {
    for (let attempt = 0; attempt < XMODEM_EOT_RETRIES; attempt++) {
        await writePort(port, Buffer.from([EOT]));
        const r = await queue.readByte(BLOCK_ACK_TIMEOUT_MS);
        if (r === ACK) {
            return;
        }
        // Bootloaders sometimes NAK the first EOT then ACK the second.
    }
    throw new Error("Bootloader did not acknowledge end-of-transmission");
}

export interface GhiLoaderFlashOptions {
    port: string;
    vendorId: number;
    productId: number;
    /** The signed .ghi image the bootloader will validate + decrypt. */
    data: Buffer;
    /** Bytes-written progress, for the progress bar. */
    onProgress: (written: number, total: number) => void;
    /** Notable status lines, for the notification. */
    onStatus?: (line: string) => void;
    /** Everything, for the output channel. */
    log: (line: string) => void;
}

/**
 * Push the signed .ghi image through the GHI BL2 bootloader.
 *
 * The board is assumed to be in bootloader mode already: the manifest's
 * `enterBootloader` string tells the user how to get it there ("hold LDR,
 * tap RESET, release LDR"), and the caller waits until the loader's USB
 * identity is detected before calling this.
 */
export async function flashGhiLoader(opts: GhiLoaderFlashOptions): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const port: any = await openPort(opts.port);
    const queue = new ByteQueue();

    // Push incoming bytes into the queue.  Errors and closes fail whatever
    // read is currently waiting so the flow does not hang on a lost cable.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    port.on("data", (d: Buffer) => queue.push(d));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    port.on("error", (e: Error) => queue.fail(e));
    port.on("close", () => queue.fail(new Error("The bootloader port disconnected")));

    try {
        // 1. Sync + version.  Bootloader responds with a banner terminated
        //    by "OK.\r\n" -- proves we are talking to the right device before
        //    doing anything destructive.
        opts.onStatus?.("connecting to bootloader...");
        opts.log("> V");
        const banner = await sendCommand(port, queue, "V", /OK\.\r?\n/, BANNER_TIMEOUT_MS);
        opts.log(banner.trimEnd());

        // 2. Enter GHI upload mode.  X asks for confirmation; Y begins the
        //    CRC-XMODEM handshake and the bootloader starts emitting 'C'.
        //    Between packet 1 and its ACK the bootloader erases the target
        //    region, based on the address/size in the encrypted header -- no
        //    separate E command is needed (the E command's Y/N confirmation
        //    is a separate exchange that only wastes flash cycles for a full
        //    reflash like this).
        opts.onStatus?.("preparing image transfer...");
        opts.log("> X");
        await sendCommand(port, queue, "X", /\?/, PROMPT_TIMEOUT_MS);
        opts.log("> Y");
        await writePort(port, Buffer.from("Y\r", "latin1"));
        await waitForCRC(queue, CRC_WAIT_TIMEOUT_MS);

        // 3. Send the file in 1K blocks.  XMODEM block numbers start at 1
        //    and wrap through 0.  Progress reported per block.  The first
        //    block's ACK is slow because the bootloader erases the target
        //    flash region before acking; sendBlock accepts a per-call
        //    timeout so we can allow for that without slowing everything.
        opts.onStatus?.("Please wait: erasing flash and writing image...");
        const total = opts.data.length;
        let written = 0;
        let seq = 1;
        let isFirstBlock = true;
        while (written < total) {
            const slice = opts.data.subarray(written, Math.min(written + XMODEM_PACKET_SIZE, total));
            await sendBlock(port, queue, seq, slice, isFirstBlock);
            written += slice.length;
            seq = (seq + 1) & 0xFF;
            isFirstBlock = false;
            opts.onProgress(written, total);
            if (written === XMODEM_PACKET_SIZE) {
                // First block landed -- erase completed, per-block writes will
                // be quick from here.
                opts.onStatus?.("writing image...");
            }
        }

        // 4. End of transmission.
        opts.onStatus?.("finishing...");
        await sendEot(port, queue);

        // 5. Run.  R also requires a Y/N confirmation like X does -- send R,
        //    wait for the confirmation prompt, then Y.  After Y the bootloader
        //    jumps into the just-flashed firmware and stops responding to the
        //    loader protocol from this point on, so we do not read back.
        opts.log("> R");
        await sendCommand(port, queue, "R", /\?/, PROMPT_TIMEOUT_MS);
        opts.log("> Y");
        await writePort(port, Buffer.from("Y\r", "latin1"));
    } finally {
        await closePort(port);
    }
}

/**
 * Talk to the loader just far enough to prove it is a GHI bootloader.
 *
 * Used by detect.ts / updateFirmware.ts to disambiguate a serial port that
 * happens to share our VID/PID window.  Sends V, expects an OK.-terminated
 * reply -- anything else is not our bootloader.
 */
export async function probeGhiLoader(portPath: string, log: (line: string) => void): Promise<boolean> {
    let port: unknown;
    try {
        port = await openPort(portPath);
        const queue = new ByteQueue();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (port as any).on("data", (d: Buffer) => queue.push(d));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (port as any).on("error", (e: Error) => queue.fail(e));
        const banner = await sendCommand(port as EventEmitter, queue, "V",
            /OK\.\r?\n/, BANNER_TIMEOUT_MS);
        log(banner.trimEnd());
        return true;
    } catch (e) {
        log(`probeGhiLoader: ${(e as Error).message}`);
        return false;
    } finally {
        if (port) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            await closePort(port as any);
        }
    }
}
