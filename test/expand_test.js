/** Deploy a script with containers, break, and expand them. */
const { DeviceLink, findPorts } = require("../out/deviceLink");
const Cond = { Stopped: 1, Attached: 4 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SRC = `class Sensor:
    def __init__(self):
        self.name = "temp"
        self.pin = 7
        self.history = [1, 2, 3]


sensor = Sensor()
long_text = "x" * 300
big = list(range(40))
readings = [10, 20, 30]
config = {"name": "sensor", "pin": 7, "scale": 1.5}
nested = [[1, 2], {"a": 1}]


def sample(n):
    total = n + 1
    return total


count = 0
while True:
    count = sample(count)
`;
// Derived from the source, never hardcoded: editing SRC shifts every line
// below, and a stale constant makes the test fail for a reason that has
// nothing to do with what it is testing.
const BP_LINE = SRC.split(String.fromCharCode(10)).findIndex((l) => l.includes("total = n + 1")) + 1;

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
    await link.putFile("main.py", Buffer.from(SRC, "utf8"));
    link.reboot(1);
    await link.close(); await sleep(1200);
    link = await connect();
    if (!link) { console.log("gone"); process.exit(1); }

    const stops = [];
    link.on("stopped", (e) => stops.push(e));
    await link.conditions(Cond.Attached, 0);
    await link.setBreakpoints([{ file: "main.py", line: BP_LINE }]);
    await link.resume();
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && !stops.length) await sleep(50);
    if (!stops.length) { console.log("breakpoint never hit"); process.exit(1); }
    console.log("stopped at line", stops[0].line, "\n");

    const globals = await link.variables(0, 1);
    let ok = true;
    for (const name of ["readings", "config", "nested", "sensor", "big"]) {
        const v = globals.find((g) => g.name === name);
        if (!v) { console.log(`  ${name}: MISSING`); ok = false; continue; }
        console.log(`  ${name} = ${v.value}   handle=${v.handle}`);
        if (v.handle === 0) { console.log(`     no handle -- not expandable`); ok = false; continue; }
        const kids = await link.children(v.handle);
        for (const k of kids) {
            console.log(`     ${k.name} = ${k.value}${k.handle ? `  handle=${k.handle}` : ""}`);
        }
        if (!kids.length) ok = false;
    }

    // nested expansion: open a child of a child
    const nested = globals.find((g) => g.name === "nested");
    if (nested && nested.handle) {
        const kids = await link.children(nested.handle);
        const inner = kids.find((k) => k.handle);
        if (inner) {
            console.log(`\n  nested${inner.name} expands to:`);
            for (const k of await link.children(inner.handle)) {
                console.log(`     ${k.name} = ${k.value}`);
            }
        } else { ok = false; }
    }

    // a leaf must not offer an arrow
    const lt = globals.find((g) => g.name === "long_text");
    console.log(`
  long_text truncates to ${lt.value.length} chars`);
    const big = globals.find((g) => g.name === "big");
    const bigKids = await link.children(big.handle);
    console.log(`  big has ${bigKids.length} children (list(range(40)) -> expect 40, paginated)`);
    if (bigKids.length !== 40) ok = false;

    const count = globals.find((g) => g.name === "count");
    console.log(`\n  count = ${count.value}  handle=${count.handle} (must be 0)`);
    if (count.handle !== 0) ok = false;

    console.log("\nRESULT:", ok ? "PASS - containers expand" : "FAIL");
    await link.setBreakpoints([]);
    await link.conditions(0, Cond.Stopped | Cond.Attached);
    await link.close();
    process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
