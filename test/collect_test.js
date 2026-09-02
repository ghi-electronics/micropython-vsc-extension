/**
 * What a deploy picks up, and what it leaves alone.
 *
 *   node test/collect_test.js
 *
 * Runs against a temporary directory rather than a board: the question here is
 * which files are chosen, and getting that wrong either fills a 111 KB
 * filesystem with things the device cannot use, or silently omits a library the
 * program imports.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { MicroPythonDebugSession } = require("../out/debugSession");

function makeTree(root) {
    const files = [
        "main.py",
        "lib/mathutil.py",
        "lib/vendor/driver.mpy",
        "lib/vendor/__init__.py",
        "data/config.json",
        "data/table.csv",
        "readme.md",
        "notes.txt",
        "__pycache__/main.cpython-311.pyc",
        ".vscode/launch.json",
        "shadowed.py",
        "shadowed.mpy",
    ];
    for (const f of files) {
        const full = path.join(root, ...f.split("/"));
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, "x");
    }
}

// collectSources and the glob helper are private; reach them the way a test
// may, rather than widening the class's surface for testing alone.
function collect(root, globs) {
    const s = new MicroPythonDebugSession();
    s.programDir = root;
    s.entryName = "main.py";
    const res = s.collectSources(
        root, globs.map((g) => MicroPythonDebugSession.globToRegExp(g)));
    return res.map((f) => path.relative(root, f).split(path.sep).join("/")).sort();
}

const CASES = [
    {
        name: "code only, no include globs",
        globs: [],
        expect: ["lib/mathutil.py", "lib/vendor/__init__.py",
            "lib/vendor/driver.mpy", "main.py", "shadowed.mpy", "shadowed.py"],
    },
    {
        name: "one data glob",
        globs: ["data/*.json"],
        expect: ["data/config.json", "lib/mathutil.py", "lib/vendor/__init__.py",
            "lib/vendor/driver.mpy", "main.py", "shadowed.mpy", "shadowed.py"],
    },
    {
        name: "recursive glob",
        globs: ["**/*.csv"],
        expect: ["data/table.csv", "lib/mathutil.py", "lib/vendor/__init__.py",
            "lib/vendor/driver.mpy", "main.py", "shadowed.mpy", "shadowed.py"],
    },
];

function main() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mpy-collect-"));
    makeTree(root);

    let failures = 0;
    for (const c of CASES) {
        const got = collect(root, c.globs);
        const ok = JSON.stringify(got) === JSON.stringify(c.expect.slice().sort());
        if (!ok) { failures++; }
        console.log(`${ok ? "PASS" : "FAIL"}  ${c.name}`);
        if (!ok) {
            console.log(`      expected ${JSON.stringify(c.expect.slice().sort())}`);
            console.log(`      got      ${JSON.stringify(got)}`);
        }
    }

    // Dotfiles and __pycache__ are excluded structurally, so even the widest
    // glob must not pull them in: they are useless on the device and the
    // filesystem has no room to waste.
    const all = collect(root, ["**/*"]);
    for (const bad of ["__pycache__/main.cpython-311.pyc", ".vscode/launch.json"]) {
        const excluded = !all.includes(bad);
        if (!excluded) { failures++; }
        console.log(`${excluded ? "PASS" : "FAIL"}  never deployed even by **/*: ${bad}`);
    }
    // A plain file is deployed only when a glob asks for it -- readme.md is not
    // code, so it must be absent by default and present under **/*.
    const byDefault = collect(root, []).includes("readme.md");
    const byGlob = all.includes("readme.md");
    const optIn = !byDefault && byGlob;
    if (!optIn) { failures++; }
    console.log(`${optIn ? "PASS" : "FAIL"}  readme.md deployed only when a glob asks`);

    // The .py/.mpy shadowing warning must fire, because a stale .mpy makes
    // breakpoints land at line numbers from whenever it was last compiled.
    const s = new MicroPythonDebugSession();
    const warnings = [];
    s.log = (m) => warnings.push(m);
    s.warnShadowedSources(["main.py", "shadowed.py", "shadowed.mpy"]);
    const warned = warnings.some((w) => w.includes("shadowed.py") && w.includes("shadowed.mpy"));
    if (!warned) { failures++; }
    console.log(`${warned ? "PASS" : "FAIL"}  warns that shadowed.mpy hides shadowed.py`);

    fs.rmSync(root, { recursive: true, force: true });
    console.log(`\nRESULT: ${failures === 0 ? "PASS" : "FAIL"}`);
    process.exit(failures === 0 ? 0 : 1);
}

main();
