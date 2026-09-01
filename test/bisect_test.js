/**
 * Isolate what crashes the board when listing globals.
 *
 * Two changes landed together: class-instance expansion and paginated replies.
 * Each case below adds exactly one kind of value to globals, so whichever case
 * kills the device names the culprit rather than leaving both suspect.
 *
 * Run it after a clean boot. If the device stops answering, the last case
 * printed is the one that did it.
 */
const { DeviceLink, findPorts } = require("../out/deviceLink");
const Cond = { Stopped: 1, Attached: 4 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Each case is a program whose globals hold one interesting value.
const CASES = [
    ["plain values only", "a = 1\nb = 'hi'\n"],
    ["a list", "a = [1, 2, 3]\n"],
    ["a dict", "a = {'k': 1}\n"],
    ["a long string (128+ chars)", "a = 'x' * 300\n"],
    ["many globals (forces pagination)",
        Array.from({ length: 40 }, (_, i) => `g${i} = ${i}`).join("\n") + "\n"],
    ["a class instance", "class S:\n    def __init__(self):\n        self.a = 1\n\n\ns = S()\n"],
    ["a function object", "def f():\n    pass\n"],
    ["a module object", "import time\n"],
];

const TAIL = "\nx = 0\nwhile True:\n    x = x + 1\n";

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

async function runCase(label, body) {
    let link = await connect();
    if (!link) return `${label}: device did not enumerate`;

    const src = body + TAIL;
    const bpLine = src.split(String.fromCharCode(10))
        .findIndex((l) => l.includes("x = x + 1")) + 1;

    try {
        await link.putFile("main.py", Buffer.from(src, "utf8"));
        await link.reboot(1);
        await link.close();
        await sleep(1200);
        link = await connect();
        if (!link) return `${label}: did not come back after reset`;

        const stops = [];
        link.on("stopped", (e) => stops.push(e));
        await link.conditions(Cond.Attached, 0);
        await link.setBreakpoints([{ file: "main.py", line: bpLine }]);
        await link.resume();

        const deadline = Date.now() + 6000;
        while (Date.now() < deadline && !stops.length) await sleep(50);
        if (!stops.length) return `${label}: breakpoint never hit`;

        // The suspect call: listing globals formats every value and asks each
        // whether it is expandable.
        const vars = await link.variables(0, 1);
        const names = vars.map((v) => v.name).join(",");

        await link.setBreakpoints([]);
        await link.conditions(0, Cond.Stopped | Cond.Attached);
        await link.close();
        return `${label}: OK (${vars.length} globals: ${names.slice(0, 60)})`;
    } catch (e) {
        try { await link.close(); } catch { /* already gone */ }
        return `${label}: FAILED -- ${e.message}`;
    }
}

async function main() {
    for (const [label, body] of CASES) {
        const result = await runCase(label, body);
        console.log(result);
        if (result.includes("FAILED") || result.includes("did not")) {
            console.log("\n^ stopped here; this case is the culprit.");
            break;
        }
    }
}

main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
