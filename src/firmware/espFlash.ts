/**
 * Flashing an ESP32 through its ROM loader.
 *
 * ESP32 has no mass-storage bootloader, so there is no drive to copy a file
 * onto: the ROM speaks a SLIP-framed serial protocol.  Rather than ship
 * esptool.py (which would drag in a Python runtime) or the IDF, this uses
 * `esptool-js` -- Espressif's own TypeScript implementation of that protocol,
 * about 600 KB, the minimum tool for the job.
 *
 * The one piece of glue needed is a shim.  esptool-js was written for the Web
 * Serial API in a browser, and this is Node; but its Transport only ever
 * touches six members of the port object -- open, close, getInfo, readable,
 * writable and setSignals -- so bridging the `serialport` package to that
 * shape is small and complete.  Web Streams are globals on the Node that
 * VS Code 1.85 ships, so nothing else is required.
 */

import type { IEspLoaderTerminal } from "esptool-js";

/**
 * Load esptool-js from its bundled build.
 *
 * The package ships ESM whose own internal imports omit the file extension
 * (`from "./util"`, not `"./util.js"`).  Node's ESM resolver requires the
 * extension, so importing the package by name fails at runtime with
 * `ERR_MODULE_NOT_FOUND` for a path inside the package itself -- it only
 * resolves when a bundler processes it.  `bundle.js` is a self-contained
 * CommonJS build with the same exports, so that is what is loaded.  The types
 * still come from the package root, which is type-only and erased.
 */
type EsptoolModule = typeof import("esptool-js");
let esptoolModule: EsptoolModule | undefined;
function esptool(): EsptoolModule {
    if (!esptoolModule) {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        esptoolModule = require("esptool-js/bundle.js") as EsptoolModule;
    }
    return esptoolModule;
}

// serialport is a native module, loaded lazily so a load failure surfaces from
// the command that needed it (as in deviceLink.ts).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let serialportModule: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function serialport(): any {
    if (!serialportModule) {
        serialportModule = require("serialport");
    }
    return serialportModule;
}

/** Shown when the board goes away mid-operation, from several code paths. */
const DISCONNECTED =
    "The board disconnected during the update. Its firmware is incomplete -- reconnect it, " +
    "hold BOOT, tap RESET, and run the update again.";

/**
 * Give up if the flash makes no progress for this long.
 *
 * esptool-js retries internally and has no overall deadline, so without this a
 * board that stops answering (a pulled cable, a brownout) leaves the progress
 * notification frozen with no way out but reloading the window.
 */
const FLASH_STALL_MS = 30_000;

/**
 * Give up waiting for the serial port to open.
 *
 * Opening a port another process already holds can block indefinitely, and the
 * stall watchdog cannot rescue it: the watchdog aborts by closing the port, and
 * close() returns immediately while isOpen is still false.  So the open needs
 * its own deadline or nothing ever settles -- which showed up as the "waiting
 * for a board" notification hanging forever.
 */
const OPEN_TIMEOUT_MS = 10_000;

/** A probe is a handshake, not a transfer, so it should give up sooner. */
const PROBE_STALL_MS = 15_000;

/**
 * Baud rate requested of the loader.
 *
 * Deliberately left at the ROM default so that esptool performs no baud change
 * at all.  These boards are USB devices -- native CDC on the S2, USB
 * Serial/JTAG on the S3 -- where the line rate is a fiction the hardware
 * ignores, so a faster setting buys nothing; but esptool still runs the
 * change-baud handshake, and on the XIAO ESP32-S3 that wedges: it prints
 * "Changed", then its own warning about the chip not responding to further
 * commands, and never returns.  Measured on the board.
 */
const LOADER_BAUD = 115200;

/**
 * A Node serial port wearing a Web Serial face.
 *
 * Deliberately not typed as the DOM `SerialPort` -- that type is not available
 * in a Node build, and implementing it in full would mean declaring members
 * esptool-js never calls.  The cast happens once, at the Transport boundary,
 * with this comment as the justification.
 */
class NodeWebSerialPort {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private port: any;
    /** Set once the port has failed, so later writes fail fast instead of hanging. */
    public lost: Error | undefined;
    public readable: ReadableStream<Uint8Array> | null = null;
    public writable: WritableStream<Uint8Array> | null = null;

    constructor(
        private readonly path: string,
        private readonly vendorId: number,
        private readonly productId: number,
    ) { }

    getInfo(): { usbVendorId: number; usbProductId: number } {
        return { usbVendorId: this.vendorId, usbProductId: this.productId };
    }

    async open(options: { baudRate: number }): Promise<void> {
        const { SerialPort } = serialport();
        this.port = new SerialPort({
            path: this.path,
            baudRate: options.baudRate,
            autoOpen: false,
        });

        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(
                `Timed out opening ${this.path}. Another program may have it open -- ` +
                `close any serial monitor or REPL using that port.`)), OPEN_TIMEOUT_MS);
            this.port.open((err: Error | null) => {
                clearTimeout(timer);
                if (err) {
                    reject(err);
                } else {
                    resolve();
                }
            });
        });

        this.readable = new ReadableStream<Uint8Array>({
            start: (controller) => {
                this.port.on("data", (d: Buffer) => {
                    try {
                        controller.enqueue(new Uint8Array(d));
                    } catch {
                        // Stream already closed; the flash is over.
                    }
                });
                this.port.on("error", (e: Error) => {
                    this.lost = e;
                    try {
                        controller.error(e);
                    } catch { /* already errored */ }
                });
                // Unplugging the board closes the port without an error event.
                // The stream has to be failed here too, or a read that is
                // waiting for a reply never settles and the flash hangs
                // forever with the progress bar frozen.
                this.port.on("close", () => {
                    this.lost = this.lost ?? new Error(DISCONNECTED);
                    try {
                        controller.error(this.lost);
                    } catch { /* already errored */ }
                });
            },
            cancel: () => {
                this.port?.removeAllListeners("data");
            },
        });

        this.writable = new WritableStream<Uint8Array>({
            write: (chunk) => new Promise<void>((resolve, reject) => {
                // serialport's write callback is never invoked on a port that
                // has gone away, so this is checked rather than relied upon.
                if (this.lost) {
                    reject(this.lost);
                    return;
                }
                if (!this.port?.isOpen) {
                    reject(new Error(DISCONNECTED));
                    return;
                }
                this.port.write(Buffer.from(chunk), (err: Error | null | undefined) =>
                    (err ? reject(err) : resolve()));
            }),
        });
    }

    /**
     * DTR/RTS.  On a board with a USB-serial bridge these drive the auto-reset
     * circuit; on a native-USB part such as the ESP32-S2 nothing is wired to
     * them and this is a no-op -- which is why the user resets by hand.  Errors
     * are swallowed for exactly that reason.
     */
    async setSignals(signals: {
        dataTerminalReady?: boolean; requestToSend?: boolean;
    }): Promise<void> {
        try {
            await new Promise<void>((resolve) => {
                this.port.set(
                    { dtr: signals.dataTerminalReady, rts: signals.requestToSend },
                    () => resolve());
            });
        } catch {
            // No modem control lines on this port.
        }
    }

    async close(): Promise<void> {
        this.readable = null;
        this.writable = null;
        if (!this.port?.isOpen) {
            return;
        }
        await new Promise<void>((resolve) => this.port.close(() => resolve()));
    }

    /** Force the port shut to break a hung read. Used by the stall watchdog. */
    async abort(reason: Error): Promise<void> {
        this.lost = reason;
        try {
            await this.close();
        } catch {
            // Already gone, which is the outcome wanted anyway.
        }
    }
}

export interface EspConnectOptions {
    port: string;
    vendorId: number;
    productId: number;
    log: (line: string) => void;
}

export interface EspFlashOptions extends EspConnectOptions {
    /** The merged image (bootloader + partition table + app). */
    data: Buffer;
    /** Where it goes. A merged image is written at 0. */
    address: number;
    /**
     * The chip this firmware is for, as esptool names it ("ESP32-S3").
     *
     * The S3's ROM loader shares its USB identity (303a:1001) with the C3, C6
     * and H2, so the device's VID/PID cannot prove which part is on the other
     * end.  When this is set the chip that actually answers is checked against
     * it, and a mismatch aborts before a single byte is written.
     */
    expectedChip?: string;
    onProgress: (written: number, total: number) => void;
    /** Overrides for diagnosing a board that refuses a write. */
    compress?: boolean;
    flashSize?: string;
    before?: string;
}

/**
 * The chip did not answer.
 *
 * Overwhelmingly this means the board is not in its bootloader.  It is its own
 * type because on a board like the XIAO ESP32-S3 -- whose USB identity is
 * identical running and in download mode -- this is the only way to tell the
 * two apart, so the caller needs to react to it rather than just report it.
 */
export class EspNotRespondingError extends Error {}

/**
 * Compare the chip esptool reported with the one expected.
 *
 * Loose on purpose: esptool's names carry qualifiers a manifest has no reason
 * to reproduce ("ESP32-S3 (QFN56) (revision v0.2)"), so this asks whether the
 * expected part appears in the reported name rather than demanding equality.
 */
function chipMatches(reported: string, expected: string): boolean {
    const norm = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, "");
    return norm(reported).includes(norm(expected));
}

/**
 * Connect to a board in its ROM loader and hand the loader to `fn`.
 *
 * The flash and the probe share this so there is one place that knows how to
 * open the port, run the stall watchdog, and tear everything down whatever
 * happens.  `keepAlive` lets the body tell the watchdog it is still making
 * progress.
 *
 * `no_reset` is deliberate at both ends: the board is already in download mode
 * because the user held BOOT and tapped RESET, and a native-USB part cannot be
 * reset over the wire anyway -- attempting it would at best do nothing and at
 * worst knock the board out of download mode.
 */
async function withLoader<T>(
    opts: EspConnectOptions,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fn: (loader: any, chip: string, keepAlive: () => void) => Promise<T>,
    stallMs: number = FLASH_STALL_MS,
    before: string = "no_reset",
): Promise<T> {
    const { ESPLoader, Transport } = esptool();

    const terminal: IEspLoaderTerminal = {
        clean: () => { /* the output channel is append-only */ },
        writeLine: (data: string) => opts.log(data),
        write: (data: string) => opts.log(data),
    };

    const shim = new NodeWebSerialPort(opts.port, opts.vendorId, opts.productId);
    // The one cast: see NodeWebSerialPort's doc comment.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const transport = new Transport(shim as any, false);
    const loader = new ESPLoader({ transport, baudrate: LOADER_BAUD, terminal });

    // Anything the loader does -- handshake, erase, write -- counts as progress.
    // The watchdog only fires when the board has genuinely stopped answering.
    let lastActivity = Date.now();
    let stalled = false;
    const keepAlive = () => { lastActivity = Date.now(); };
    const watchdog = setInterval(() => {
        if (Date.now() - lastActivity > stallMs) {
            stalled = true;
            void shim.abort(new Error(DISCONNECTED));
        }
    }, 2000);

    // A hard deadline that nothing inside esptool-js can defeat.
    //
    // The stall watchdog aborts by closing the port, which relies on the
    // library propagating the resulting stream error.  It does not always: a
    // wedged handshake sat forever with the port shut underneath it.  Racing
    // the whole operation against a timer is the only guarantee that this
    // function settles, which is what the caller needs above all else.
    let deadlineTimer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
        deadlineTimer = setTimeout(
            () => reject(new EspNotRespondingError(
                `The board stopped responding after ${stallMs / 1000} seconds.`)),
            stallMs * 2);
    });

    const run = async (): Promise<T> => {
        let chip: string;
        try {
            chip = await loader.main(before as never);
        } catch (err) {
            // Distinguish "nothing answered" from a failure mid-operation: the
            // first is the ordinary "you have not pressed BOOT yet" case.
            throw new EspNotRespondingError(
                shim.lost?.message ?? (err as Error)?.message ?? "no response");
        }
        keepAlive();
        opts.log(`Connected to ${chip}`);
        return await fn(loader, chip, keepAlive);
    };

    try {
        return await Promise.race([run(), deadline]);
    } catch (err) {
        // The watchdog closes the port to break a hung read, so what surfaces
        // is a stream error about a closed port.  Report why it was closed.
        if (stalled) {
            throw new Error(
                `The board stopped responding for ${stallMs / 1000} seconds. ` +
                "If an update was in progress its firmware is incomplete -- reconnect " +
                "it, hold BOOT, tap RESET, and try again.");
        }
        if (err instanceof EspNotRespondingError) {
            throw err;
        }
        throw shim.lost ?? err;
    } finally {
        clearInterval(watchdog);
        clearTimeout(deadlineTimer);
        // Closing the port is what lets any work still running inside the
        // library unblock and be garbage collected after a deadline fired.
        try {
            await transport.disconnect();
        } catch {
            // The port may already be gone.
        }
        await shim.close();
    }
}

/**
 * Ask the board what chip it is, writing nothing.
 *
 * Used to tell a board sitting in its ROM loader from one merely plugged in,
 * on parts where USB cannot: the XIAO ESP32-S3 presents the identical
 * VID/PID/serial in both states, so the only way to know is that the ROM
 * answers and a running application does not.  Throws EspNotRespondingError
 * when nothing answers, which is the "not in the bootloader" signal.
 */
export async function probeEspChip(opts: EspConnectOptions): Promise<string> {
    try {
        return await withLoader(opts, async (_loader, chip) => chip, PROBE_STALL_MS);
    } catch (err) {
        // A probe runs against a board that may well not be listening, so every
        // way of not getting an answer -- no reply, a port that will not open,
        // the watchdog firing -- means the same thing to the caller: this is
        // not a board in its bootloader. Only that must never hang.
        if (err instanceof EspNotRespondingError) {
            throw err;
        }
        throw new EspNotRespondingError((err as Error)?.message ?? String(err));
    }
}

/** Write one image to a board sitting in the ROM loader. */
export async function flashEsp(opts: EspFlashOptions): Promise<void> {
    await withLoader(opts, async (loader, chip, keepAlive) => {
        if (opts.expectedChip && !chipMatches(chip, opts.expectedChip)) {
            throw new Error(
                `This is a ${chip}, but the firmware selected is for an ` +
                `${opts.expectedChip}. Nothing was written. Check which board is in ` +
                `its bootloader -- several Espressif parts share the same USB identity ` +
                `while in their ROM loader.`);
        }

        await loader.writeFlash({
            fileArray: [{ data: new Uint8Array(opts.data), address: opts.address }],
            flashMode: "keep",
            flashFreq: "keep",
            flashSize: (opts.flashSize ?? "keep") as never,
            eraseAll: false,
            compress: opts.compress ?? true,
            reportProgress: (_i: number, written: number, total: number) => {
                keepAlive();
                opts.onProgress(written, total);
            },
        });

        // `loader.after()` is deliberately not called.
        //
        // The only mode wanted here is "leave the chip alone" -- the user taps
        // RESET, because a native-USB part cannot be restarted over the wire.
        // But esptool-js implements that as a soft reset, which it supports on
        // the ESP8266 and nothing else, and it raises the failure on a promise
        // it never awaits.  That surfaces as an unhandled rejection no caller
        // can catch, after a flash that had completed perfectly.  Not calling
        // it leaves the board in exactly the state we want anyway.
    }, FLASH_STALL_MS, opts.before ?? "no_reset");
}
