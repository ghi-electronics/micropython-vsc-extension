/**
 * Deploy throughput, and the thing that pays for it.
 *
 *   node test/deploy_speed_test.js
 *
 * The device used to call storage_flush() on every File_Put chunk. Chunks are
 * ~470 bytes and a flash page is 2 KB, so one file erased and reprogrammed the
 * same page four or five times -- the deploy speed ceiling, and four times the
 * flash wear. Protocol v5 flushes once per file instead.
 *
 * The saving is only safe if a written file still survives a reset, because
 * that is exactly what the flush was added to guarantee: without it, a deploy
 * reported success, the reset discarded the dirty cache, and the board ran the
 * previous version of the code. So this measures the speed AND re-checks the
 * file after a hard reset. A fast run that loses the file is a failure, not a
 * win.
 */
const { DeviceLink, findPorts } = require("../out/deviceLink");
const { crc32 } = require("../out/wireProtocol");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Big enough to span several flash pages, small enough not to be tedious.
const SIZE = 8 * 1024;
const NAME = "speedtest.dat";

function payload(n) {
    // Pseudo-random but reproducible, so a truncated or stale file cannot
    // accidentally match the CRC.
    const b = Buffer.alloc(n);
    let x = 0x12345678;
    for (let i = 0; i < n; i++) {
        x = (x * 1103515245 + 12345) & 0x7fffffff;
        b[i] = x & 0xff;
    }
    return b;
}

async function connect(timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const p = (await findPorts()).debug;
        if (p) {
            const l = new DeviceLink();
            try { await l.open(p); await sleep(400); return l; } catch { /* retry */ }
        }
        await sleep(500);
    }
    return null;
}

async function main() {
    let link = await connect();
    if (!link) { console.log("no device found"); process.exit(1); }

    let caps;
    try {
        caps = await link.capabilities();
        console.log(`device protocol v${caps.protocol}`);
        if (caps.protocol < 5) {
            console.log("  (v4 or older: flushes on every chunk, expect ~2 KB/s)");
        }
    } catch {
        console.log("device did not report capabilities");
    }

    const data = payload(SIZE);
    const want = crc32(data);

    console.log(`\n1. pushing ${NAME}, ${SIZE} bytes`);
    const t0 = Date.now();
    const rc = await link.putFile(NAME, data);
    const ms = Date.now() - t0;
    if (rc !== 0) { console.log(`   FAILED rc=${rc}`); process.exit(1); }
    const rate = (SIZE / 1024) / (ms / 1000);
    console.log(`   ${ms} ms  ->  ${rate.toFixed(1)} KB/s`);

    console.log("\n2. verifying before reset");
    let info = await link.fileCrc(NAME);
    const okBefore = info.rc === 0 && info.size === SIZE && info.crc === want;
    console.log(`   size=${info.size}/${SIZE} crc=${okBefore ? "match" : "MISMATCH"}`);

    // The regression check. Flushing less often must not mean losing the file
    // when the board restarts -- that was the original bug.
    console.log("\n3. hard reset, then verifying again");
    await link.reboot(2 /* Hard */);
    await link.close();
    await sleep(1500);
    link = await connect();
    if (!link) { console.log("   device did not come back"); process.exit(1); }

    info = await link.fileCrc(NAME);
    const okAfter = info.rc === 0 && info.size === SIZE && info.crc === want;
    console.log(`   size=${info.size}/${SIZE} crc=${okAfter ? "match" : "MISMATCH"}`);

    console.log("\n4. cleaning up");
    await link.deleteFile(NAME);
    await link.close();

    console.log();
    console.log(`   throughput      : ${rate.toFixed(1)} KB/s`);
    console.log(`   intact before   : ${okBefore ? "PASS" : "FAIL"}`);
    console.log(`   survived reset  : ${okAfter ? "PASS" : "FAIL"}  <- the one that matters`);
    console.log(`\nRESULT: ${okBefore && okAfter ? "PASS" : "FAIL"}`);
    process.exit(okBefore && okAfter ? 0 : 1);
}

main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
