/**
 * What happens when things go wrong during a firmware update.
 *
 * The case that matters most is a board disconnected partway through a UF2
 * write.  A successful write also ends with the drive disappearing -- that is
 * how the bootloader signals it has rebooted -- so "the drive is gone" on its
 * own cannot distinguish success from a pulled cable.  Reporting a half-written
 * board as updated is the worst outcome this feature can produce, so it is
 * checked here rather than hoped for.
 *
 * No board required: a temporary directory with an INFO_UF2.TXT in it is a UF2
 * drive as far as this code is concerned, and deleting that file mid-write is
 * exactly what unplugging looks like.
 *
 *   node test/firmware_failure_test.js
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const { writeUf2, findUf2Drives } = require("../out/firmware/drives");

const INFO = "UF2 Bootloader v3.0\r\nModel: Raspberry Pi RP2\r\nBoard-ID: RPI-RP2\r\n";

let failures = 0;
function check(name, ok, detail) {
    if (!ok) {
        failures++;
    }
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
    if (!ok && detail) {
        console.log(`      ${detail}`);
    }
}

function makeFakeDrive() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uf2drive-"));
    fs.writeFileSync(path.join(dir, "INFO_UF2.TXT"), INFO);
    return dir;
}

function removeDrive(dir) {
    // The volume going away is modelled by INFO_UF2.TXT going away, which is
    // what driveGone() actually tests for.
    try {
        fs.unlinkSync(path.join(dir, "INFO_UF2.TXT"));
    } catch { /* already gone */ }
}

async function main() {
    // --- a complete write, then the board reboots: success ------------------
    {
        const dir = makeFakeDrive();
        const data = Buffer.alloc(300 * 1024, 0xa5);
        let lastWritten = 0;

        const p = writeUf2(dir, data, (written) => {
            lastWritten = written;
            if (written >= data.length) {
                // The bootloader takes the last block and resets.
                removeDrive(dir);
            }
        });

        let err;
        try {
            await p;
        } catch (e) {
            err = e;
        }
        check("a complete write that ends with the drive gone succeeds",
            err === undefined, err && err.message);
        check("progress reached the full size",
            lastWritten === data.length, `saw ${lastWritten} of ${data.length}`);
        fs.rmSync(dir, { recursive: true, force: true });
    }

    // --- unplugged halfway: must NOT be reported as success -----------------
    {
        const dir = makeFakeDrive();
        const data = Buffer.alloc(300 * 1024, 0x5a);

        const p = writeUf2(dir, data, (written) => {
            if (written >= data.length / 2) {
                removeDrive(dir);          // cable pulled mid-write
            }
        });

        let err;
        try {
            await p;
        } catch (e) {
            err = e;
        }
        check("a half-written board is reported as a failure",
            err !== undefined,
            "writeUf2 resolved -- a partially flashed board would be called updated");
        check("the failure says the board was disconnected",
            err !== undefined && /disconnected mid-update/i.test(err.message),
            err && err.message);
        check("the failure says what to do next",
            err !== undefined && /hold BOOT/i.test(err.message),
            err && err.message);
        fs.rmSync(dir, { recursive: true, force: true });
    }

    // --- a drive that never goes away: the image did not suit the chip ------
    {
        const dir = makeFakeDrive();
        const data = Buffer.alloc(8 * 1024, 0x11);

        let err;
        try {
            await writeUf2(dir, data);     // drive stays mounted throughout
        } catch (e) {
            err = e;
        }
        check("a drive that stays mounted is reported as a failure",
            err !== undefined, "writeUf2 resolved despite the board never restarting");
        check("that failure names the likely cause",
            err !== undefined && /did not restart/i.test(err.message),
            err && err.message);
        fs.rmSync(dir, { recursive: true, force: true });
    }

    // --- scanning must not throw when nothing is attached -------------------
    {
        let err;
        let drives;
        try {
            drives = await findUf2Drives();
        } catch (e) {
            err = e;
        }
        check("scanning for drives never throws",
            err === undefined, err && err.message);
        check("scanning returns an array",
            Array.isArray(drives), typeof drives);
    }

    console.log(`\n${failures === 0 ? "all checks passed" : failures + " failed"}`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("ERROR:", e); process.exit(1); });
