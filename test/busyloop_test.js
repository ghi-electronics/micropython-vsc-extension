/**
 * The debug channel must survive a program that never idles.
 *
 * A tight loop reaches the VM's branch hook but never the idle path, so if the
 * pump is gated on the debugger being armed, the device becomes unreachable the
 * moment the host detaches -- with no way back except the RUN_APP pin.
 */
const { DeviceLink, findPorts } = require("../out/deviceLink");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const Cond = { Stopped: 1, Attached: 4 };

const BUSY = "x = 0\nwhile True:\n    x = x + 1\n";   // no sleep anywhere

async function connect(ms = 25000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        const p = (await findPorts()).debug;
        if (p) { const l = new DeviceLink(); try { await l.open(p); await sleep(400); return l; } catch {} }
        await sleep(500);
    }
    return null;
}

async function main() {
    let link = await connect();
    if (!link) { console.log("no device"); process.exit(1); }

    const before = (await link.capabilities()).vmHookCalls;
    console.log("deploying a busy loop with no sleep...");
    await link.putFile("main.py", Buffer.from(BUSY, "utf8"));

    // Reboot WITHOUT wait-for-debugger: the program runs immediately and the
    // host is not attached, which is the case that used to go dark.
    link.reboot(0);
    await link.close();
    await sleep(1500);
    link = await connect();
    if (!link) { console.log("device did not come back"); process.exit(1); }

    console.log("\nprogram is now spinning. Can the host still talk to it?");
    let ok = true;
    for (let i = 1; i <= 3; i++) {
        try {
            const t0 = Date.now();
            const p = await link.ping();
            console.log(`  ping ${i}: ${p ? "ok" : "bad reply"} (${Date.now() - t0} ms)`);
            if (!p) ok = false;
        } catch (e) {
            console.log(`  ping ${i}: FAILED -- ${e.message}`);
            ok = false;
        }
        await sleep(300);
    }

    if (ok) {
        const after = (await link.capabilities()).vmHookCalls;
        console.log(`\n  VM hook calls: ${before} -> ${after} (+${after - before})`);
        console.log("  attaching and pausing a spinning program:");
        await link.conditions(Cond.Attached, 0);
        const stops = [];
        link.on("stopped", (e) => stops.push(e));
        await link.pause();
        const deadline = Date.now() + 4000;
        while (Date.now() < deadline && !stops.length) await sleep(50);
        console.log(stops.length ? `    paused at line ${stops[0].line}` : "    FAILED to pause");
        if (!stops.length) ok = false;
        await link.conditions(0, Cond.Stopped | Cond.Attached);
    }

    console.log("\nRESULT:", ok ? "PASS - reachable while spinning" : "FAIL - went dark");
    // leave the board idle rather than spinning
    await link.deleteFile("main.py");
    link.reboot(0);
    await link.close();
    process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
