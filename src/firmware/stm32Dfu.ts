// Copyright (c) GHI Electronics.
// SPDX-License-Identifier: MIT

/**
 * Flashing a board that is sitting in STM32's ROM DFU bootloader.
 *
 * ST's implementation is DFU 1.1 with the DfuSe extensions (block 0 carries
 * one-byte command codes: 0x21 "set address pointer", 0x41 "erase page"), and
 * everything else is standard: DFU_DNLOAD is a class-specific interface
 * control transfer, DFU_GETSTATUS is polled until state settles, block
 * numbering starts at 2 for the actual firmware bytes because block 0 is the
 * address-pointer command and block 1 is skipped so the first data byte
 * lands at pointer + 0.
 *
 * The device enumerates as USB class DFU, not as a serial port, so serialport
 * cannot see it -- we use libusb via the `usb` npm package.  That package is
 * lazy-loaded for the same reason serialport is: it is a native module and a
 * load failure should surface from the command that needed it, not break
 * activation.  Windows users need the WinUSB driver on the 0x0483:0xDF11
 * device (Zadig, or STM32CubeProgrammer's installer); the extension cannot
 * install this on their behalf.
 *
 * Wire protocol reference: F:\NewDaisyLink\duelink-loader\src\update.vue (the
 * DueLink loader speaks the same thing over WebUSB), plus ST AN3156 and the
 * DFU 1.1 specification.  The three prior debugging incidents baked into this
 * file:
 *
 *   1. Not calling CLRSTATUS at the top -- a previous session that failed
 *      mid-transfer leaves the state at dfuERROR and every subsequent
 *      DNLOAD returns errWRITE without touching flash.
 *   2. Starting data blocks at 1 instead of 2 -- the first 1024 bytes land
 *      at pointer + 1024 and the reset vector at offset 0 is left as 0xFF,
 *      which shows up as "board bricked, works with STM32CubeProgrammer".
 *   3. Not waiting for status between erases -- DFU_STATE is dfuDNBUSY for
 *      a documented poll_timeout while the page is erasing; sending the
 *      next DNLOAD during that window silently loses it and the affected
 *      page reads back as 0xFF.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

// STM32 ROM DFU device identity, fixed in silicon (per ST AN2606).
export const STM32_DFU_VID = 0x0483;
export const STM32_DFU_PID = 0xDF11;

// Class-specific DFU request codes, from DFU 1.1 spec.
const DFU_DNLOAD    = 0x01;
const DFU_GETSTATUS = 0x03;
const DFU_CLRSTATUS = 0x04;
const DFU_ABORT     = 0x06;

// DFU states we branch on (a subset of the spec's 10-state machine).
const DFU_STATE_DFU_IDLE          = 2;
const DFU_STATE_DFU_DNLOAD_IDLE   = 5;
const DFU_STATE_DFU_ERROR         = 10;

// DfuSe block-0 command bytes.
const DFUSE_CMD_ERASE       = 0x41;
const DFUSE_CMD_SET_ADDRESS = 0x21;

// Standard transfer size.  STM32 ROM's DFU functional descriptor advertises
// 2048 on some parts, but 1024 is the pragmatic choice used by every ST
// tool (DfuSe, CubeProgrammer, dfu-util --transfer-size 1024) and matches
// the reference project's DFU_TRANSFER_SIZE.
const DFU_TRANSFER_SIZE = 1024;

// STM32C0 page size (per RM0490).  Wider families use 2 KB too but if a
// different STM32 gets added the manifest can override this via `chip`.
const DEFAULT_PAGE_ERASE_SIZE = 2048;

let usbModule: any;
function usb(): any {
    if (!usbModule) {
        try {
            usbModule = require("usb");
        } catch (err) {
            throw new Error(
                "USB support is not available. The 'usb' native module failed to load: "
                + (err as Error).message
                + "\n\nOn Windows, STM32 DFU flashing also needs the WinUSB driver "
                + "installed on the 0x0483:0xDF11 DFU device -- use Zadig or install "
                + "STM32CubeProgrammer, which bundles the driver.");
        }
    }
    return usbModule;
}

/**
 * A DFU device that is currently sitting in its bootloader.
 *
 * Serial number is captured for two reasons: to disambiguate when the user
 * has two boards plugged in at once, and to include in log output so a
 * failure is tied to a specific board rather than to "the DFU device".
 */
export interface DfuDevice {
    vendorId: number;
    productId: number;
    /** libusb Device object; opaque to callers. */
    handle: any;
    serial?: string;
}

/**
 * All STM32 ROM DFU devices currently enumerated.  Nothing is opened or
 * claimed here -- open() happens inside flashStm32Dfu -- so the caller can
 * offer the user a choice when more than one is present.
 */
export async function listDfuDevices(): Promise<DfuDevice[]> {
    const mod = usb();
    const list = mod.getDeviceList() as any[];
    const hits = list.filter((d) =>
        d.deviceDescriptor.idVendor === STM32_DFU_VID
        && d.deviceDescriptor.idProduct === STM32_DFU_PID);

    const out: DfuDevice[] = [];
    for (const h of hits) {
        let serial: string | undefined;
        // The device has to be opened to read its string descriptors, but
        // closed straight away so flashStm32Dfu can open it exclusively.
        try {
            h.open();
            try {
                serial = await new Promise<string | undefined>((resolve) => {
                    h.getStringDescriptor(
                        h.deviceDescriptor.iSerialNumber,
                        (err: Error | undefined, data: string | undefined) => {
                            resolve(err ? undefined : data);
                        });
                });
            } finally {
                try { h.close(); } catch { /* ignore */ }
            }
        } catch {
            // No permission (Linux without udev rules) or driver missing
            // (Windows without WinUSB): still list the device so the caller
            // can surface a clear "cannot open" error at flash time.
        }
        out.push({
            vendorId: STM32_DFU_VID,
            productId: STM32_DFU_PID,
            handle: h,
            serial,
        });
    }
    return out;
}

interface DfuStatus {
    status: number;        // 0 = OK
    pollTimeoutMs: number; // device asks host to wait this long
    state: number;         // one of DFU_STATE_*
}

/** Options accepted by flashStm32Dfu, mirroring the esp/ghi flasher shapes. */
export interface FlashDfuOptions {
    vendorId: number;
    productId: number;
    data: Buffer;
    /** Flash base address, e.g. 0x08000000 for STM32 main flash. */
    address: number;
    /** Erase granularity in bytes. Defaults to 2 KB (STM32C0/G0/L4 pages). */
    pageEraseSize?: number;
    onStatus?: (line: string) => void;
    onProgress?: (written: number, total: number) => void;
    log?: (line: string) => void;
}

/**
 * Write `data` to a board that is already in ROM DFU mode.  Follows ST's
 * DfuSe single-session sequence (see the reference project for the same
 * shape over WebUSB): clear any stale error state, erase the pages that
 * will be programmed, set the address pointer, stream data blocks, close
 * the session with a zero-length DNLOAD.
 *
 * Progress is byte counts; the caller renders the bar.  The function
 * resolves as soon as the ROM has accepted every byte and started the
 * manifest phase; the board reboots into the newly written firmware on
 * its own after that.
 */
export async function flashStm32Dfu(opts: FlashDfuOptions): Promise<void> {
    const mod = usb();
    const list = mod.getDeviceList() as any[];
    const device = list.find((d) =>
        d.deviceDescriptor.idVendor === opts.vendorId
        && d.deviceDescriptor.idProduct === opts.productId);
    if (!device) {
        throw new Error(
            `No DFU device found (0x${opts.vendorId.toString(16)}:0x${opts.productId.toString(16)}). `
            + "The board is not in ROM DFU mode, or another program is holding it open.");
    }

    try {
        device.open();
    } catch (err) {
        throw explainDfuOpenError(err as Error);
    }
    try {
        await runDfuSession(device, opts);
    } finally {
        try { device.close(); } catch { /* ignore -- reset already released it */ }
    }
}

/**
 * Turn a libusb open failure into something the user can act on.  The most
 * common cause on Windows is that the STM32 Bootloader USB device does not
 * have a WinUSB driver bound to it; libusb reports LIBUSB_ERROR_NOT_SUPPORTED
 * or LIBUSB_ERROR_NOT_FOUND, neither of which is meaningful to a user.  On
 * Linux it is usually a udev-rules gap that shows up as LIBUSB_ERROR_ACCESS.
 * Every other error is left with its original message.
 */
function explainDfuOpenError(err: Error): Error {
    const msg = err.message ?? "";
    if (process.platform === "win32"
        && (/not\s*supported/i.test(msg) || /not\s*found/i.test(msg))) {
        return new Error(
            "Windows cannot open the STM32 Bootloader device because no WinUSB "
            + "driver is bound to it.  Install STM32CubeProgrammer (which bundles "
            + "the driver) or run Zadig and select the WinUSB driver for "
            + "'STM32 BOOTLOADER'.  Then reset the board into DFU mode again and "
            + "retry.  Original error: " + msg);
    }
    if (/access|permission/i.test(msg) && process.platform === "linux") {
        return new Error(
            "Permission denied opening the STM32 Bootloader device.  Add a udev "
            + "rule so your user can talk to 0483:df11 without sudo, for example:\n"
            + "  SUBSYSTEM==\"usb\", ATTRS{idVendor}==\"0483\", "
            + "ATTRS{idProduct}==\"df11\", MODE=\"0666\"\n"
            + "in /etc/udev/rules.d/50-stm32-dfu.rules, then reload with "
            + "'sudo udevadm control --reload-rules' and replug.  Original error: "
            + msg);
    }
    return err;
}

async function runDfuSession(device: any, opts: FlashDfuOptions): Promise<void> {
    const log = opts.log ?? (() => undefined);
    const status = opts.onStatus ?? (() => undefined);
    const pageSize = opts.pageEraseSize ?? DEFAULT_PAGE_ERASE_SIZE;

    // Configuration 1 is DFU-mode on the ROM; there is nothing else on this
    // device so we do not have to hunt for the right interface.
    await new Promise<void>((resolve, reject) => {
        device.setConfiguration(1, (err: Error | null | undefined) => {
            err ? reject(err) : resolve();
        });
    });

    const iface = device.interface(0);
    try {
        // Linux may attach a kernel driver we do not want fighting us for
        // this interface; detach is a no-op on Windows.
        if (iface.isKernelDriverActive?.()) {
            iface.detachKernelDriver();
        }
    } catch {
        // Not fatal -- flash may still work if nothing else is holding it.
    }
    iface.claim();

    try {
        // Any past session that failed leaves the ROM parked in dfuERROR;
        // every subsequent DNLOAD fails until CLRSTATUS clears it.  So do
        // that first, unconditionally, before we ask what state it is in.
        await clearErrorIfSet(device);

        // Erase the pages that will be programmed.  Erase before setting the
        // address pointer: the erase command carries its own address (block-0
        // 0x41 prefix), so pointer state does not matter here.
        const totalPages = Math.ceil(opts.data.length / pageSize);
        status(`Erasing ${totalPages} flash page(s)...`);
        for (let i = 0; i < totalPages; i++) {
            const pageAddr = opts.address + i * pageSize;
            await sendEraseCommand(device, pageAddr);
            await waitForIdle(device);
            log(`erased 0x${pageAddr.toString(16)}`);
        }

        // Point the ROM at the flash destination.  Every subsequent data
        // block advances the pointer by its own length, so this is set once.
        await sendSetAddress(device, opts.address);
        await waitForIdle(device);
        log(`address pointer set to 0x${opts.address.toString(16)}`);

        status("Writing firmware...");
        const total = opts.data.length;
        let written = 0;
        let blockNumber = 2;   // 0 = command, 1 = skipped, 2 = first data
        while (written < total) {
            const chunk = opts.data.subarray(written, written + DFU_TRANSFER_SIZE);
            await dfuDownload(device, blockNumber, chunk);
            await waitForIdle(device);
            written += chunk.length;
            blockNumber++;
            opts.onProgress?.(written, total);
        }

        // Leave DFU mode and jump to the freshly written firmware.  This is
        // the ST DfuSe "exit + jump" sequence, and it is subtly different
        // from just "we're done writing":
        //
        //   1. SET_ADDRESS(entry) resets the ROM's address pointer.  Without
        //      this the pointer is still at wherever the LAST data block
        //      landed (base + firmware_length), and the empty DNLOAD below
        //      would tell the ROM to jump *there* -- into freshly written but
        //      unrelated flash, past the entry vectors -- and the board hangs.
        //   2. Zero-length DNLOAD transitions the ROM to dfuMANIFEST-SYNC,
        //      which the ROM then interprets as "verify and jump to the
        //      current pointer address" because we set the pointer to the
        //      entry in step 1.
        //   3. GETSTATUS pushes the state machine through MANIFEST -> reset.
        //
        // Without step 1 the board sits in DFU forever until the user taps
        // RESET.  Same fix as the reference DueLink loader's Go() (F:\...
        // duelink-loader\src\update.vue).  ST's ROM disconnects USB during
        // step 3, so the final GETSTATUS commonly errors with a pipe-broken
        // or I/O error -- that is the jump landing, not a failure.
        status("Finalising...");
        try {
            await sendSetAddress(device, opts.address);
            await waitForIdle(device);
            log(`entry point set to 0x${opts.address.toString(16)} -- jumping`);
            await dfuDownload(device, 0, Buffer.alloc(0));
            await waitForIdle(device);
        } catch (err) {
            log(`manifest phase ended with ${(err as Error).message} (expected: device is resetting)`);
        }
    } finally {
        try {
            iface.release(true, () => undefined);
        } catch {
            // Ignore -- the ROM will have reset by now on the happy path.
        }
    }
}

/** DFU_DNLOAD: class OUT to interface 0, wValue=blockNumber. */
function dfuDownload(device: any, blockNumber: number, data: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
        device.controlTransfer(
            0x21,                   // bmRequestType: class, host->device, interface
            DFU_DNLOAD,
            blockNumber & 0xFFFF,
            0,                      // wIndex: interface number
            data.length === 0 ? Buffer.alloc(0) : data,
            (err: Error | null | undefined) => {
                err ? reject(err) : resolve();
            });
    });
}

/** DFU_GETSTATUS: class IN, 6 bytes back. */
function dfuGetStatus(device: any): Promise<DfuStatus> {
    return new Promise((resolve, reject) => {
        device.controlTransfer(
            0xA1,                   // bmRequestType: class, device->host, interface
            DFU_GETSTATUS,
            0,
            0,
            6,
            (err: Error | null | undefined, data: Buffer | undefined) => {
                if (err || !data || data.length !== 6) {
                    reject(err ?? new Error("DFU_GETSTATUS did not return 6 bytes"));
                    return;
                }
                resolve({
                    status: data.readUInt8(0),
                    pollTimeoutMs: data.readUInt8(1)
                        | (data.readUInt8(2) << 8)
                        | (data.readUInt8(3) << 16),
                    state: data.readUInt8(4),
                });
            });
    });
}

/** DFU_CLRSTATUS: class OUT with no data. */
function dfuClrStatus(device: any): Promise<void> {
    return new Promise((resolve, reject) => {
        device.controlTransfer(
            0x21, DFU_CLRSTATUS, 0, 0, Buffer.alloc(0),
            (err: Error | null | undefined) => err ? reject(err) : resolve());
    });
}

/** DFU_ABORT: class OUT with no data. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function dfuAbort(device: any): Promise<void> {
    return new Promise((resolve, reject) => {
        device.controlTransfer(
            0x21, DFU_ABORT, 0, 0, Buffer.alloc(0),
            (err: Error | null | undefined) => err ? reject(err) : resolve());
    });
}

async function clearErrorIfSet(device: any): Promise<void> {
    const s = await dfuGetStatus(device);
    if (s.state === DFU_STATE_DFU_ERROR || s.status !== 0) {
        await dfuClrStatus(device);
        // Re-check once so a persistent stuck state fails cleanly rather
        // than looping forever inside waitForIdle later.
        const after = await dfuGetStatus(device);
        if (after.state === DFU_STATE_DFU_ERROR) {
            throw new Error(
                `DFU device stayed in error state (status=${after.status}) after CLRSTATUS. `
                + "Unplug and replug the board, then try again.");
        }
    }
}

/** Poll GETSTATUS until the ROM reports it is back to an idle state. */
async function waitForIdle(device: any): Promise<void> {
    // A generous cap: each erase on STM32C0 takes ~20-30 ms, so the loop
    // typically exits after one or two iterations.  100 iterations at the
    // suggested poll delay is minutes -- plenty of margin for pathological
    // cases without hanging forever.
    for (let i = 0; i < 100; i++) {
        const s = await dfuGetStatus(device);
        if (s.status !== 0) {
            throw new Error(`DFU device reported error status ${s.status} in state ${s.state}`);
        }
        if (s.state === DFU_STATE_DFU_IDLE || s.state === DFU_STATE_DFU_DNLOAD_IDLE) {
            return;
        }
        // Honour the ROM's own suggested poll interval so we do not hammer
        // the endpoint while it is busy erasing / writing.
        await new Promise((r) => setTimeout(r, Math.max(1, s.pollTimeoutMs)));
    }
    throw new Error("DFU device did not return to idle within the timeout");
}

/** Send a DfuSe "erase page" block-0 command. */
function sendEraseCommand(device: any, pageAddress: number): Promise<void> {
    const cmd = Buffer.alloc(5);
    cmd.writeUInt8(DFUSE_CMD_ERASE, 0);
    cmd.writeUInt32LE(pageAddress >>> 0, 1);
    return dfuDownload(device, 0, cmd);
}

/** Send a DfuSe "set address pointer" block-0 command. */
function sendSetAddress(device: any, address: number): Promise<void> {
    const cmd = Buffer.alloc(5);
    cmd.writeUInt8(DFUSE_CMD_SET_ADDRESS, 0);
    cmd.writeUInt32LE(address >>> 0, 1);
    return dfuDownload(device, 0, cmd);
}
