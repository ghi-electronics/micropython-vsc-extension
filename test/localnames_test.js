/**
 * Local name recovery.
 *
 *   node test/localnames_test.js
 *
 * The device names arguments from the bytecode; everything else has to be
 * derived from source, and the order must match the order the compiler
 * allocates slots -- parameters first, then each name the first time the
 * function binds it.
 *
 * Every case below is a binding form that a scan for `name =` alone would miss.
 * Missing one is not a cosmetic problem: names are matched to slots by
 * position, so one omission shifts every name after it onto the wrong value.
 */
const { deriveLocalNames, verifyAgainstDevice } = require("../out/localNames");

const CASES = [
    {
        name: "plain assignments",
        src: [
            "def f(a, b):",
            "    total = a + b",
            "    result = total * 2",
            "    return result",
        ],
        expect: ["a", "b", "total", "result"],
    },
    {
        name: "for-loop variable",
        src: [
            "def f(n):",
            "    total = 0",
            "    for i in range(n):",
            "        total += i",
            "    return total",
        ],
        expect: ["n", "total", "i"],
    },
    {
        name: "tuple unpacking",
        src: [
            "def f(pair):",
            "    lo, hi = pair",
            "    return lo + hi",
        ],
        expect: ["pair", "lo", "hi"],
    },
    {
        name: "for with unpacking",
        src: [
            "def f(items):",
            "    for key, value in items:",
            "        print(key, value)",
        ],
        expect: ["items", "key", "value"],
    },
    {
        name: "augmented assignment introduces a name",
        src: [
            "def f(a):",
            "    count = 0",
            "    count += a",
            "    return count",
        ],
        expect: ["a", "count"],
    },
    {
        name: "with ... as",
        src: [
            "def f(path):",
            "    with open(path) as fh:",
            "        data = fh.read()",
            "    return data",
        ],
        expect: ["path", "fh", "data"],
    },
    {
        name: "except ... as",
        src: [
            "def f(x):",
            "    try:",
            "        y = 1 / x",
            "    except ZeroDivisionError as err:",
            "        y = None",
            "    return y",
        ],
        expect: ["x", "y", "err"],
    },
    {
        name: "keyword and default arguments",
        src: [
            "def f(a, b=2, *rest, **kw):",
            "    total = a + b",
            "    return total",
        ],
        expect: ["a", "b", "rest", "kw", "total"],
    },
    {
        name: "attribute and subscript targets are not locals",
        src: [
            "def f(obj, arr):",
            "    obj.field = 1",
            "    arr[0] = 2",
            "    real = 3",
            "    return real",
        ],
        expect: ["obj", "arr", "real"],
    },
    {
        name: "global declaration is not a local",
        src: [
            "def f(a):",
            "    global counter",
            "    counter = a",
            "    local = 1",
            "    return local",
        ],
        expect: ["a", "local"],
    },
    {
        name: "assignment inside a string or comment is ignored",
        src: [
            "def f(a):",
            "    msg = 'total = 5'   # other = 3",
            "    return msg",
        ],
        expect: ["a", "msg"],
    },
    {
        name: "nested def binds its own name",
        src: [
            "def f(a):",
            "    def inner(b):",
            "        return b",
            "    return inner(a)",
        ],
        expect: ["a", "inner"],
    },
    {
        name: "import inside a function",
        src: [
            "def f():",
            "    import time",
            "    from sys import path as syspath",
            "    return time, syspath",
        ],
        expect: ["time", "syspath"],
    },
    {
        name: "comparison is not an assignment",
        src: [
            "def f(a):",
            "    if a == 1:",
            "        flag = True",
            "    return flag",
        ],
        expect: ["a", "flag"],
    },
    {
        name: "stops at the end of the function",
        src: [
            "def f(a):",
            "    inside = 1",
            "    return inside",
            "",
            "outside = 2",
        ],
        expect: ["a", "inside"],
    },
];

function main() {
    let failures = 0;
    for (const c of CASES) {
        const got = deriveLocalNames(c.src.join("\n"), 1);
        const ok = JSON.stringify(got) === JSON.stringify(c.expect);
        if (!ok) { failures++; }
        console.log(`${ok ? "PASS" : "FAIL"}  ${c.name}`);
        if (!ok) {
            console.log(`      expected ${JSON.stringify(c.expect)}`);
            console.log(`      got      ${JSON.stringify(got)}`);
        }
    }

    // The safety net: if the derived order disagrees with the argument names
    // the device read from the bytecode, the whole result must be rejected.
    const checks = [
        [["a", "b", "t"], ["a", "b"], true, "arguments agree"],
        [["b", "a", "t"], ["a", "b"], false, "arguments in the wrong order"],
        [["a", "t"], ["a", "b"], false, "an argument is missing"],
        [["a"], ["a", "b"], false, "fewer names than arguments"],
    ];
    for (const [derived, device, want, label] of checks) {
        const got = verifyAgainstDevice(derived, device);
        const ok = got === want;
        if (!ok) { failures++; }
        console.log(`${ok ? "PASS" : "FAIL"}  verification rejects: ${label}`);
    }

    console.log(`\nRESULT: ${failures === 0 ? "PASS" : "FAIL"}`);
    process.exit(failures === 0 ? 0 : 1);
}

main();
