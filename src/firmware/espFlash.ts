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
            this.port.open((err: Error | null) => (err ? reject(err) : resolve()));
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

export interface EspFlashOptions {
    port: string;
    vendorId: number;
    productId: number;
    /** The merged image (bootloader + partition table + app), as built by `esptool --merge-bin`. */
    data: Buffer;
    /** Where it goes. A merged image is written at 0. */
    address: number;
    onProgress: (written: number, total: number) => void;
    log: (line: string) => void;
}

/**
 * Write one image to a board sitting in the ROM loader.
 *
 * `no_reset` is used at both ends deliberately.  The board is already in
 * download mode because the user held BOOT and tapped RESET, and a native-USB
 * part cannot be reset over the wire anyway -- attempting it would at best do
 * nothing and at worst knock the board out of download mode.  The caller tells
 * the user to tap RESET when this returns.
 */
export async function flashEsp(opts: EspFlashOptions): Promise<void> {
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

    const loader = new ESPLoader({
        transport,
        baudrate: 921600,
        terminal,
    });

    // Anything the loader does -- handshake, erase, write -- counts as progress.
    // The watchdog only fires when the board has genuinely stopped answering.
    let lastActivity = Date.now();
    let stalled = false;
    const watchdog = setInterval(() => {
        if (Date.now() - lastActivity > FLASH_STALL_MS) {
            stalled = true;
            void shim.abort(new Error(DISCONNECTED));
        }
    }, 2000);

    try {
        const chip = await loader.main("no_reset");
        lastActivity = Date.now();
        opts.log(`Connected to ${chip}`);

        await loader.writeFlash({
            fileArray: [{ data: new Uint8Array(opts.data), address: opts.address }],
            flashMode: "keep",
            flashFreq: "keep",
            flashSize: "keep",
            eraseAll: false,
            compress: true,
            reportProgress: (_i, written, total) => {
                lastActivity = Date.now();
                opts.onProgress(written, total);
            },
        });

        await loader.after("no_reset");
    } catch (err) {
        // The watchdog closes the port to break a hung read, so what surfaces
        // is a stream error about a closed port.  Report why it was closed.
        if (stalled) {
            throw new Error(
                `The board stopped responding for ${FLASH_STALL_MS / 1000} seconds. ` +
                "Its firmware is incomplete -- reconnect it, hold BOOT, tap RESET, " +
                "and run the update again.");
        }
        throw shim.lost ?? err;
    } finally {
        clearInterval(watchdog);
        try {
            await transport.disconnect();
        } catch {
            // The port may already be gone.
        }
        await shim.close();
    }
}
