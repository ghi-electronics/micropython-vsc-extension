/**
 * Fetching the firmware index and the firmware itself.
 *
 * The index is `micropython_firmware.json` on the GHI website, and it
 * deliberately follows the same shape as `tinyclr_firmware.json` that already
 * lives beside it: `schemaVersion`, a `families` array, `usb` vid/pid as hex
 * strings, site-relative `url`, and an `md5`.  Two products publishing firmware
 * the same way means one set of website tooling, and a maintainer who has
 * updated one can update the other without learning a second format.
 *
 * Two rules shape the code:
 *
 *   1. **Verify before writing.**  By the time we flash, the user has already
 *      put the board into its bootloader; a truncated download at that point
 *      writes a broken image to a board that cannot refuse it.  Every artifact
 *      is checked against its digest before it goes near a board.
 *
 *   2. **Work offline once it has worked online.**  Verified downloads are
 *      cached under the extension's global storage, keyed by digest, so a
 *      reflash on a bad network -- or on a bench with none -- reuses what is
 *      already known-good rather than failing.
 *
 * No new dependencies: `fetch` and `node:crypto` are both built in on the Node
 * that VS Code 1.85 ships.
 */

import * as vscode from "vscode";
import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as path from "path";
import type { FlashKind } from "./boards";

/** USB identity, written as hex strings to match tinyclr_firmware.json. */
export interface UsbId { vid: string; pid: string; }

/** One flashable firmware, as published in the index. */
export interface FirmwareFamily {
    /** Matches the MicroPython board name, e.g. "RPI_PICO2". */
    id: string;
    /** Shown to the user. */
    name: string;
    /** How it reaches the chip. Defaults to "uf2-drive" when absent. */
    kind?: FlashKind;
    /**
     * How the board is recognised while in its bootloader.
     *
     * `boardId` is the `Board-ID:` line of INFO_UF2.TXT for a UF2 drive;
     * `usb` is the ROM loader's VID/PID for a serial bootloader.  Carrying
     * these in the index (rather than only in boards.ts) means a new board can
     * be published without shipping a new extension.
     */
    bootloader?: { boardId?: string; usb?: UsbId };
    version: string;
    /** ISO date the firmware was published. Shown so "latest" is legible. */
    date?: string;
    /** Site-relative ("/bin/fw/...") or absolute. Resolved against the index URL. */
    url: string;
    /** Uppercase or lowercase hex MD5, as tinyclr_firmware.json publishes. */
    md5?: string;
    /** Optional and preferred when present. */
    sha256?: string;
    /** Byte length, used only to drive the progress bar. */
    size?: number;
    /**
     * Flash offset for "esp-rom" firmware.  A merged image (bootloader +
     * partition table + application, combined at build time by
     * `esptool --merge-bin`) is written at 0, which is why the extension never
     * has to know the individual offsets.  Defaults to 0.
     */
    address?: number;
}

export interface Manifest {
    /** Bumped when the shape changes, so an old extension fails clearly. */
    schemaVersion: number;
    /** Where the index is generated from, mirroring tinyclr_firmware.json. */
    source?: string;
    families: FirmwareFamily[];
}

/** The schema version this build understands. */
const SCHEMA_VERSION = 1;

/**
 * Abort a transfer that has gone this long without delivering a byte.
 *
 * Not an overall deadline -- a slow connection on a large image is legitimate
 * and must be allowed to finish.  What must not be allowed is waiting forever
 * on a socket that was accepted and then went quiet, which is what a pulled
 * cable, a captive portal or a dropped VPN looks like from here.
 */
const STALL_MS = 30_000;

/** The index is small; if it has not arrived by now, something is wrong. */
const INDEX_TIMEOUT_MS = 20_000;

const MANIFEST_CACHE = "micropython_firmware.json";

function manifestUrl(): string {
    const cfg = vscode.workspace.getConfiguration("micropython-sitcore");
    return cfg.get<string>("firmwareManifestUrl", "").trim();
}

async function cacheDir(context: vscode.ExtensionContext): Promise<string> {
    const dir = context.globalStorageUri.fsPath;
    await fs.mkdir(dir, { recursive: true });
    return dir;
}

export function md5(data: Buffer): string {
    return crypto.createHash("md5").update(data).digest("hex");
}

export function sha256(data: Buffer): string {
    return crypto.createHash("sha256").update(data).digest("hex");
}

/** Parse "0x303A" or "303a" into a number. */
export function parseHexId(s: string | undefined): number | undefined {
    if (!s) {
        return undefined;
    }
    const n = parseInt(s.replace(/^0x/i, ""), 16);
    return Number.isFinite(n) ? n : undefined;
}

/**
 * Absolute URL for a family's artifact.
 *
 * The index publishes site-relative paths ("/bin/fw/name.uf2") exactly as
 * tinyclr_firmware.json does, so they are resolved against the index's own URL
 * rather than against a separately configured host that could drift out of step.
 */
export function artifactUrl(family: FirmwareFamily, indexUrl: string): string {
    return new URL(family.url, indexUrl).toString();
}

/**
 * Load the firmware index.
 *
 * Network first, cache second.  A stale index that still lets the user reflash
 * is worth more than an error, so a fetch failure is reported through the
 * returned `stale` flag rather than thrown, as long as a cached copy exists.
 */
export async function loadManifest(
    context: vscode.ExtensionContext,
): Promise<{ manifest: Manifest; url: string; stale: boolean }> {
    const url = manifestUrl();
    if (url === "") {
        throw new Error(
            "No firmware index configured. Set 'micropython-sitcore.firmwareManifestUrl' " +
            "in settings, or use 'Flash Firmware from File' with a local build.");
    }

    const cachePath = path.join(await cacheDir(context), MANIFEST_CACHE);

    let fetched: string | undefined;
    try {
        const res = await fetch(url, {
            redirect: "follow",
            signal: AbortSignal.timeout(INDEX_TIMEOUT_MS),
        });
        if (!res.ok) {
            throw new Error(`HTTP ${res.status} ${res.statusText}`);
        }
        fetched = await res.text();
    } catch {
        // Offline, blocked, or too slow.  The cache is tried next.
        fetched = undefined;
    }

    if (fetched !== undefined) {
        const parsed = parseManifest(fetched);
        // Only cache what parsed, so a mangled response cannot poison the cache.
        await fs.writeFile(cachePath, fetched, "utf8");
        return { manifest: parsed, url, stale: false };
    }

    let cached: string;
    try {
        cached = await fs.readFile(cachePath, "utf8");
    } catch {
        throw new Error(`Cannot reach the firmware index at ${url}, and nothing is cached yet.`);
    }
    return { manifest: parseManifest(cached), url, stale: true };
}

function parseManifest(text: string): Manifest {
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch {
        throw new Error("The firmware index is not valid JSON.");
    }
    const m = raw as Partial<Manifest>;
    if (typeof m.schemaVersion !== "number" || !Array.isArray(m.families)) {
        throw new Error("The firmware index is missing 'schemaVersion' or 'families'.");
    }
    if (m.schemaVersion > SCHEMA_VERSION) {
        throw new Error(
            `The firmware index uses format ${m.schemaVersion}, but this extension ` +
            `understands ${SCHEMA_VERSION}. Update the MicroPython extension.`);
    }
    for (const f of m.families) {
        if (!f.id || !f.url) {
            throw new Error(`Firmware index entry '${f.id ?? "?"}' is missing id or url.`);
        }
        if (!f.md5 && !f.sha256) {
            throw new Error(
                `Firmware index entry '${f.id}' has no md5 or sha256. Firmware is not ` +
                `written to a board unverified.`);
        }
    }
    return m as Manifest;
}

/** Check a download against whichever digest the index published. */
function digestMatches(data: Buffer, family: FirmwareFamily): { ok: boolean; detail: string } {
    if (family.sha256) {
        const want = family.sha256.toLowerCase();
        const got = sha256(data);
        return {
            ok: got === want,
            detail: `sha256 ${got.slice(0, 16)}... expected ${want.slice(0, 16)}...`,
        };
    }
    const want = (family.md5 ?? "").toLowerCase();
    const got = md5(data);
    return { ok: got === want, detail: `md5 ${got} expected ${want}` };
}

/** Cache key: the published digest, so a changed artifact is never served from cache. */
function cacheKey(family: FirmwareFamily): string {
    return (family.sha256 ?? family.md5 ?? "").toLowerCase();
}

/**
 * Fetch one artifact, verified.
 *
 * A cached file whose digest still matches is returned without touching the
 * network.  A cached file whose digest does not match is deleted and re-fetched
 * rather than trusted.
 */
export async function downloadFirmware(
    context: vscode.ExtensionContext,
    family: FirmwareFamily,
    indexUrl: string,
    onProgress: (received: number, total: number | undefined) => void,
    token?: vscode.CancellationToken,
): Promise<Buffer> {
    const cached = path.join(await cacheDir(context), `${cacheKey(family)}.bin`);

    try {
        const have = await fs.readFile(cached);
        if (digestMatches(have, family).ok) {
            onProgress(have.length, have.length);
            return have;
        }
        await fs.unlink(cached);
    } catch {
        // Not cached, or unreadable.  Download it.
    }

    const url = artifactUrl(family, indexUrl);

    // One AbortController serves three jobs: the user pressing Cancel, the
    // stall watchdog, and tearing the socket down on any error.  Without it a
    // cancelled download would keep running in the background.
    const ac = new AbortController();
    const cancelSub = token?.onCancellationRequested(() => ac.abort());
    let lastByteAt = Date.now();
    let stalled = false;
    const watchdog = setInterval(() => {
        if (Date.now() - lastByteAt > STALL_MS) {
            stalled = true;
            ac.abort();
        }
    }, 2000);

    try {
        return await readBody(url, family, ac, () => { lastByteAt = Date.now(); },
            onProgress, cached);
    } catch (err) {
        if (token?.isCancellationRequested) {
            throw new vscode.CancellationError();
        }
        if (stalled) {
            throw new Error(
                `The download stopped receiving data for ${STALL_MS / 1000} seconds and was ` +
                `abandoned. Nothing was written to the board. Check the connection and try ` +
                `again -- the part already downloaded is not kept.`);
        }
        throw err;
    } finally {
        clearInterval(watchdog);
        cancelSub?.dispose();
    }
}

/** The transfer itself, split out so the watchdog above stays readable. */
async function readBody(
    url: string,
    family: FirmwareFamily,
    ac: AbortController,
    sawByte: () => void,
    onProgress: (received: number, total: number | undefined) => void,
    cachePath: string,
): Promise<Buffer> {
    const res = await fetch(url, { redirect: "follow", signal: ac.signal });
    if (!res.ok) {
        throw new Error(`Downloading firmware failed: HTTP ${res.status} ${res.statusText}`);
    }

    // The index's size wins over content-length.  The website serves these
    // gzipped, so content-length is the *compressed* length while what arrives
    // here is already decoded -- trusting the header would show a progress bar
    // running past 100% ("1.5 MB of 1.0 MB").
    const declared = Number(res.headers.get("content-length") ?? "");
    const total = family.size
        ?? (Number.isFinite(declared) && declared > 0 ? declared : undefined);

    const chunks: Buffer[] = [];
    let received = 0;
    if (res.body) {
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
            sawByte();
            const buf = Buffer.from(chunk);
            chunks.push(buf);
            received += buf.length;
            onProgress(received, total);
        }
    }
    const data = Buffer.concat(chunks);

    // A body that ended early still reaches here; the digest below is what
    // catches it, but saying so plainly is more use than a checksum mismatch.
    if (total !== undefined && data.length < total) {
        throw new Error(
            `The download ended after ${data.length} of ${total} bytes -- the connection ` +
            `dropped. Nothing was written to the board.`);
    }

    const check = digestMatches(data, family);
    if (!check.ok) {
        throw new Error(
            `Firmware for ${family.name} failed its checksum -- the download is incomplete, ` +
            `or the file on the server changed (${check.detail}). ` +
            `Nothing was written to the board.`);
    }

    // Caching is an optimisation.  A full disk or a read-only profile must not
    // fail an update whose bytes are already in hand and verified.
    await fs.writeFile(cachePath, data).catch(() => undefined);
    return data;
}
