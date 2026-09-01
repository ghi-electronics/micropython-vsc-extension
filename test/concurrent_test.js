/**
 * VS Code fires several DAP requests at once when it stops. This checks whether
 * the device survives concurrent in-flight commands, which every test so far
 * has issued strictly one at a time.
 */
const { DeviceLink, findPorts } = require("../out/deviceLink");
const fs = require("fs"), path = require("path");
const Cond = { Stopped: 1, Attached: 4 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect() {
    for (let i = 0; i < 40; i++) {
        const p = (await findPorts()).debug;
        if (p) { const l = new DeviceLink(); try { await l.open(p); await sleep(400); return l; } catch {} }
        await sleep(500);
    }
    return null;
}

async function main() {
    let link = await connect();
    if (!link) { console.log("no device"); process.exit(1); }
    await link.putFile("main.py", fs.readFileSync(path.join(__dirname, "..", "examples", "blink", "main.py")));
    await link.reboot(1);
    await link.close(); await sleep(1200);
    link = await connect();
    if (!link) { console.log("gone"); process.exit(1); }

    const stops = [];
    link.on("stopped", (ev) => stops.push(ev));
    await link.conditions(Cond.Attached, 0);
    await link.setBreakpoints([{ file: "main.py", line: 32 }]);
    await link.resume();

    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && stops.length === 0) await sleep(50);
    if (!stops.length) { console.log("breakpoint never hit"); process.exit(1); }
    console.log("stopped at line", stops[0].line);

    console.log("\nfiring 5 requests concurrently, as VS Code does:");
    const t0 = Date.now();
    const results = await Promise.allSettled([
        link.threads(),
        link.stack(),
        link.variables(0, 1),
        link.evaluate(0, "count"),
        link.threads(),
    ]);
    const names = ["threads", "stack", "variables", "evaluate", "threads2"];
    results.forEach((r, i) => {
        console.log(`  ${names[i].padEnd(11)} ${r.status === "fulfilled"
            ? "ok" : "FAILED: " + r.reason.message}`);
    });
    console.log(`  elapsed ${Date.now() - t0} ms`);

    await link.setBreakpoints([]);
    await link.conditions(0, Cond.Stopped | Cond.Attached);
    await link.close();
}
main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
