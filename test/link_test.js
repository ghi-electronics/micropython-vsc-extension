/**
 * Exercises the TypeScript transport against a real board, without VS Code.
 *
 * This is the same ground the Python reference client covers, re-run through
 * the code the extension will actually use. If this passes, the only untested
 * layer left is the DAP translation itself.
 *
 *   node test/link_test.js
 */
const { DeviceLink, findPorts } = require("../out/deviceLink");
const { crc32 } = require("../out/wireProtocol");

const Cond = { Stopped: 1, StopOnStart: 2, Attached: 4 };
const Step = { In: 1, Over: 2, Out: 3 };
const Reboot = { WaitForDebugger: 1 };

const MAIN_PY = `import pyb, time
led = pyb.LED(1)


def add(a, b):
    c = a + b
    return c


def blink(n):
    led.toggle()
    n = add(n, 1)
    return n


count = 0
while True:
    count = blink(count)
    time.sleep_ms(200)
`;
const BP_LINE = 11;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function waitStopped(link, timeoutMs = 8000) {
    return new Promise((resolve) => {
        const timer = setTimeout(() => { link.off("stopped", on); resolve(null); }, timeoutMs);
        const on = (ev) => { clearTimeout(timer); link.off("stopped", on); resolve(ev); };
        link.on("stopped", on);
    });
}

async function connect() {
    for (let i = 0; i < 40; i++) {
        const ports = await findPorts();
        if (ports.debug) {
            const link = new DeviceLink();
            try {
                await link.open(ports.debug);
                await sleep(400);
                return link;
            } catch { /* still enumerating */ }
        }
        await sleep(500);
    }
    return null;
}

async function main() {
    const results = {};

    console.log("crc('GHIPKT1') =", "0x" + crc32(Buffer.from("GHIPKT1")).toString(16),
        "(firmware reports 0xe3464cd8)");
    results.crc = crc32(Buffer.from("GHIPKT1")) === 0xe3464cd8;

    const ports = await findPorts();
    console.log("ports:", ports);
    if (!ports.debug) {
        console.log("no debug port found -- is the board in VCP+VCP mode?");
        process.exit(1);
    }

    let link = new DeviceLink();
    await link.open(ports.debug);
    await sleep(300);

    console.log("\n1. ping");
    results.ping = await link.ping();
    console.log("   ok:", results.ping);

    console.log("\n2. push main.py");
    const data = Buffer.from(MAIN_PY, "utf8");
    const rc = await link.putFile("main.py", data);
    const info = await link.fileCrc("main.py");
    console.log(`   put=${rc} size=${info.size}/${data.length} crcMatch=${info.crc === crc32(data)}`);
    results.file = rc === 0 && info.size === data.length && info.crc === crc32(data);

    console.log("\n3. reboot into halt (USB re-enumerates, reconnecting)");
    link.reboot(Reboot.WaitForDebugger);
    await link.close();
    await sleep(1200);
    link = await connect();
    if (!link) { console.log("   device did not come back"); process.exit(1); }
    let cond = await link.conditions();
    console.log(`   conditions=0x${cond.toString(16)} halted=${!!(cond & Cond.Stopped)}`);
    results.halted = !!(cond & Cond.Stopped);

    console.log("\n4. threads + attach + breakpoint");
    const nthreads = await link.threads();
    await link.conditions(Cond.Attached, 0);
    const nbp = await link.setBreakpoints([{ file: "main.py", line: BP_LINE }]);
    console.log(`   threads=${nthreads} breakpointsAccepted=${nbp}`);
    results.threads = nthreads === 1;
    results.breakpointsSet = nbp === 1;

    console.log("\n5. resume, wait for the breakpoint");
    let waiter = waitStopped(link);
    await link.resume();
    let ev = await waiter;
    console.log("   stopped:", ev);
    results.breakpointHit = !!ev && ev.line === BP_LINE;

    console.log("\n6. stack");
    const frames = await link.stack();
    frames.forEach((f, i) => console.log(`   #${i} ${f.file}:${f.line} in ${f.func}()`));
    results.stack = frames.length === 2 && frames[0].func === "blink";

    console.log("\n7. step over, then step in");
    waiter = waitStopped(link);
    await link.step(Step.Over);
    ev = await waiter;
    console.log(`   after step over: line ${ev && ev.line}`);
    results.stepOver = !!ev && ev.line === 12;

    waiter = waitStopped(link);
    await link.step(Step.In);
    ev = await waiter;
    const inFrames = await link.stack();
    console.log(`   after step in:   line ${ev && ev.line} depth ${inFrames.length} in ${inFrames[0] && inFrames[0].func}()`);
    results.stepIn = !!ev && ev.line === 6 && inFrames.length === 3;

    console.log("\n8. clean up");
    await link.setBreakpoints([]);
    await link.conditions(0, Cond.Stopped | Cond.Attached);
    await link.close();

    console.log();
    let ok = true;
    for (const [k, v] of Object.entries(results)) {
        console.log(`   ${k.padEnd(16)}: ${v ? "PASS" : "FAIL"}`);
        ok = ok && v;
    }
    console.log("\nRESULT:", ok ? "PASS - TypeScript transport drives the device" : "FAIL");
    process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
