/**
 * Reproduce the exact sequence the debug adapter performs, outside VS Code.
 *
 *   launch: sync -> reboot(wait) -> reconnect -> attach -> capabilities
 *   configuration: setBreakpoints -> resume
 *   then: does the device still answer? does the breakpoint fire?
 *
 * Isolates "the device stopped responding" from "the breakpoint did not match".
 */
const { DeviceLink, findPorts } = require("../out/deviceLink");

const Cond = { Stopped: 1, StopOnStart: 2, Attached: 4 };
const Scope = { Locals: 0, Globals: 1 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MAIN_PY = require("fs").readFileSync(
    require("path").join(__dirname, "..", "examples", "blink", "main.py"));
const BP_LINE = 32;   // led.value(1)

async function connect() {
    for (let i = 0; i < 40; i++) {
        const p = (await findPorts()).debug;
        if (p) {
            const link = new DeviceLink();
            try { await link.open(p); await sleep(400); return link; } catch { /* retry */ }
        }
        await sleep(500);
    }
    return null;
}

async function main() {
    let link = await connect();
    if (!link) { console.log("no device"); process.exit(1); }

    console.log("1. sync + reboot into halt");
    await link.putFile("main.py", MAIN_PY);
    await link.reboot(1 /* WaitForDebugger */);
    await link.close();
    await sleep(1200);
    link = await connect();
    if (!link) { console.log("device did not come back"); process.exit(1); }

    let stops = [];
    link.on("stopped", (ev) => { stops.push(ev); console.log("   <- stopped event:", ev); });

    console.log("2. attach + capabilities");
    console.log("   conditions:", (await link.conditions(Cond.Attached, 0)).toString(16));
    console.log("   caps:", await link.capabilities());

    console.log("3. while halted at entry, do the things VS Code does");
    for (const [label, fn] of [
        ["threads", () => link.threads()],
        ["stack", () => link.stack()],
        ["variables(globals)", () => link.variables(0, Scope.Globals)],
        ["evaluate(count)", () => link.evaluate(0, "count")],
    ]) {
        try {
            const r = await fn();
            console.log(`   ${label.padEnd(20)} ok:`, JSON.stringify(r).slice(0, 110));
        } catch (e) {
            console.log(`   ${label.padEnd(20)} FAILED: ${e.message}`);
        }
    }

    console.log("4. setBreakpoints + resume");
    console.log("   accepted:", await link.setBreakpoints([{ file: "main.py", line: BP_LINE }]));
    stops = [];
    await link.resume();

    console.log("5. waiting up to 8s for the breakpoint...");
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && stops.length === 0) {
        await sleep(100);
    }
    if (stops.length === 0) {
        console.log("   NO STOP. Is the device still answering?");
        try {
            console.log("   ping:", await link.ping());
        } catch (e) {
            console.log("   ping FAILED:", e.message, " <- the device went deaf");
        }
    } else {
        console.log("   stopped at line", stops[0].line);
        console.log("   stack:", JSON.stringify(await link.stack()));
        try {
            console.log("   variables:", JSON.stringify(await link.variables(0, Scope.Globals)).slice(0, 140));
        } catch (e) {
            console.log("   variables FAILED:", e.message);
        }
    }

    await link.setBreakpoints([]);
    await link.conditions(0, Cond.Stopped | Cond.Attached);
    await link.close();
}

main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
