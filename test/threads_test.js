/**
 * What does the debugger actually do when the program uses _thread?
 *
 * MICROPY_PY_THREAD is 1 on rp2 and esp32, so a user can start a thread today.
 * micropython_debugger.md 12.3 decided the stop model on paper; this measures
 * the behaviour before any of it is built, so the design answers what the
 * hardware really does rather than what we assume.
 *
 * The question that matters: when the debugger halts, does the OTHER thread
 * keep running? A counter incremented only by the second thread answers it --
 * read it twice while halted, and if it moved, execution did not stop.
 *
 *   node test/threads_test.js
 */
const { DeviceLink, findPorts } = require("../out/deviceLink");

const Cond = { Stopped: 1, StopOnStart: 2, Attached: 4 };
const Reboot = { WaitForDebugger: 1 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ticks is touched only by the spawned thread; main never writes it.
const MAIN_PY = `import _thread
import time

ticks = 0


def worker():
    global ticks
    while True:
        ticks = ticks + 1
        time.sleep_ms(10)


def step(n):
    total = n + 1
    return total


_thread.start_new_thread(worker, ())

count = 0
while True:
    count = step(count)
    time.sleep_ms(100)
`;
const BP_LINE = 16;   // total = n + 1, in step()

async function connect(timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const p = (await findPorts()).debug;
        if (p) {
            const link = new DeviceLink();
            try {
                await link.open(p);
                await link.ping();
                return link;
            } catch { try { await link.close(); } catch {} }
        }
        await sleep(250);
    }
    return null;
}

async function main() {
    let link = await connect();
    if (!link) { console.log("no board"); process.exit(1); }

    console.log("1. deploy a program with a second thread");
    await link.putFile("main.py", Buffer.from(MAIN_PY, "utf8"));

    console.log("2. reboot into halt");
    await link.reboot(Reboot.WaitForDebugger);
    await link.close();
    await sleep(600);
    link = await connect();
    if (!link) { console.log("   device did not come back"); process.exit(1); }

    console.log("3. attach, breakpoint in the main thread");
    await link.conditions(Cond.Attached, 0);
    console.log("   breakpoints accepted:", await link.setBreakpoints([{ file: "main.py", line: BP_LINE }]));
    console.log("   threads reported:", await link.threads());

    console.log("4. resume and wait for the breakpoint");
    // Count every stopped event, not just the first: if each thread halts
    // independently the host gets more than one, and they race over the single
    // global mp_debug_hit_code_state that the stack walk reads.
    const allStops = [];
    link.on("stopped", (e) => allStops.push(e));
    const stopped = new Promise((res) => {
        const t = setTimeout(() => res(null), 10000);
        link.once("stopped", (e) => { clearTimeout(t); res(e); });
    });
    await link.resume();
    const ev = await stopped;
    console.log("   stopped:", ev);
    if (!ev) { console.log("   never stopped -- cannot measure"); await link.close(); process.exit(1); }

    console.log("5. THE QUESTION: is the other thread still running while halted?");
    const a = await link.evaluate(0, "ticks");
    await sleep(1500);
    const b = await link.evaluate(0, "ticks");
    console.log(`   ticks at stop      : ${a.value} (ok=${a.ok})`);
    console.log(`   ticks 1.5s later   : ${b.value} (ok=${b.ok})`);

    const moved = a.ok && b.ok && a.value !== b.value;
    console.log();
    if (moved) {
        console.log("   RESULT: the second thread KEPT RUNNING while the debugger was halted.");
        console.log("           This is the gap 12.3 describes. All-stop is not implemented.");
    } else if (a.ok && b.ok) {
        console.log("   RESULT: ticks did not move -- both threads appear stopped.");
    } else {
        console.log("   RESULT: could not read ticks; evaluate failed. Inconclusive.");
    }

    console.log(`\n   stopped events received: ${allStops.length}`);
    allStops.forEach((e, i) => console.log(`     [${i}] reason=${e.reason} line=${e.line} func-file=${e.file}`));

    console.log("\n6. can the stack of the other thread be seen?");
    console.log("   stack:", JSON.stringify(await link.stack()));

    await link.setBreakpoints([]);
    await link.conditions(0, Cond.Stopped | Cond.Attached);
    await link.close();
}

main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
