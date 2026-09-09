/**
 * Breakpoint path trimming and hit-count conditions.
 *
 *   node test/breakpoint_logic_test.js
 *
 * Both decide whether a breakpoint fires, and both fail silently when wrong --
 * a breakpoint that never triggers looks identical to code that never runs.
 */
// debugSession reaches vscode through the firmware-install offer it makes when
// F5 finds no debug port. None of that is under test here, and vscode cannot be
// loaded outside the extension host, so it is stubbed before the require.
const Module = require("module");
const realLoad = Module._load;
Module._load = function (request) {
    if (request === "vscode") {
        return { window: {}, commands: {}, ProgressLocation: {} };
    }
    return realLoad.apply(this, arguments);
};

const { trimToTail } = require("../out/deviceLink");
const { MicroPythonDebugSession } = require("../out/debugSession");

const MAX = 127;

const TRIM_CASES = [
    {
        name: "short path is untouched",
        input: "lib/util.py",
        expect: "lib/util.py",
    },
    {
        name: "exactly at the limit is untouched",
        input: "a".repeat(MAX - 3) + ".py",
        expect: "a".repeat(MAX - 3) + ".py",
    },
    {
        name: "over the limit keeps whole trailing segments",
        input: "lib/" + "vendor_package/".repeat(9) + "module.py",
        check: (out) => out.length <= MAX
            && out.endsWith("module.py")
            && !out.startsWith("/")
            && !out.includes("//"),
    },
    {
        name: "a single huge segment falls back to the basename",
        input: "x".repeat(200) + "/mod.py",
        expect: "mod.py",
    },
    {
        name: "trimmed result is still a suffix of the original",
        input: "deep/" + "nested/".repeat(20) + "thing.py",
        check: (out) => ("deep/" + "nested/".repeat(20) + "thing.py").endsWith(out),
    },
];

const HIT_CASES = [
    // [expression, hit number, should stop]
    ["3", 1, false], ["3", 2, false], ["3", 3, true], ["3", 6, true],
    [">5", 5, false], [">5", 6, true],
    [">=5", 5, true], [">=5", 4, false],
    ["==2", 2, true], ["==2", 3, false],
    ["<3", 2, true], ["<3", 3, false],
    ["%4", 4, true], ["%4", 5, false],
    // Anything unparseable must not silently swallow stops.
    ["nonsense", 1, true],
    ["", 1, true],
];

function main() {
    let failures = 0;

    for (const c of TRIM_CASES) {
        const out = trimToTail(c.input, MAX);
        const ok = c.check ? c.check(out) : out === c.expect;
        if (!ok) { failures++; }
        console.log(`${ok ? "PASS" : "FAIL"}  trim: ${c.name}`);
        if (!ok) { console.log(`      got ${JSON.stringify(out)} (len ${out.length})`); }
    }

    const s = new MicroPythonDebugSession();
    for (const [expr, hits, want] of HIT_CASES) {
        const got = s.hitConditionMet(expr, hits);
        const ok = got === want;
        if (!ok) { failures++; }
        console.log(`${ok ? "PASS" : "FAIL"}  hit "${expr}" at ${hits} -> ${got}`);
    }

    console.log(`\nRESULT: ${failures === 0 ? "PASS" : "FAIL"}`);
    process.exit(failures === 0 ? 0 : 1);
}

main();
