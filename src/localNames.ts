/**
 * Recovering local variable names from source.
 *
 * MicroPython's bytecode records argument names -- the VM needs them to bind
 * keyword arguments -- but nothing maps the remaining local slots back to
 * identifiers. The device therefore reports those slots by position, with real
 * names only for the arguments.
 *
 * The names can still be worked out here, because the compiler allocates a slot
 * the first time a function binds a name, in source order. Walking the function
 * body and recording bindings in the order they appear reproduces that.
 *
 * "Reproduces" is a claim, not a guarantee, so it is checked rather than
 * trusted: the device's argument names are authoritative, and if this analysis
 * disagrees with them the whole result is discarded. See verifyAgainstDevice().
 * Names are matched to slots by position, so a single wrong name is not one
 * wrong entry -- it shifts every name after it. Leaving a value unlabelled is
 * the safe failure; labelling it wrongly is not.
 */

/** A binding site found in the source, in the order the compiler would see it. */
function pushName(names: string[], seen: Set<string>, name: string): void {
    if (!name || seen.has(name) || RESERVED.has(name)) {
        return;
    }
    seen.add(name);
    names.push(name);
}

/**
 * Keywords that can appear where an identifier would and must never be taken
 * for one. `None`, `True` and `False` are included because `x = None` is a
 * binding of x, but `for None` is not a thing -- they only matter on the
 * right-hand side, where we do not look anyway.
 */
const RESERVED = new Set([
    "if", "else", "elif", "while", "for", "in", "return", "import", "from",
    "def", "class", "try", "except", "finally", "with", "as", "pass", "break",
    "continue", "raise", "and", "or", "not", "is", "lambda", "global",
    "nonlocal", "assert", "del", "yield", "await", "async", "True", "False",
    "None",
]);

const IDENT = "[A-Za-z_][A-Za-z0-9_]*";

/** Strip a trailing comment and any string literals, so their contents cannot
 *  be mistaken for code. Crude but sufficient: we only look for binding forms,
 *  and a false negative costs a name, not a wrong one. */
function decomment(line: string): string {
    let out = "";
    let quote: string | null = null;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (quote) {
            if (c === quote && line[i - 1] !== "\\") { quote = null; }
            continue;
        }
        if (c === '"' || c === "'") { quote = c; continue; }
        if (c === "#") { break; }
        out += c;
    }
    return out;
}

/** Names bound by one target expression: `a`, `a, b`, `(a, b)`, `a[0]`, `a.b`. */
function targetNames(target: string): string[] {
    const found: string[] = [];
    for (const part of target.split(",")) {
        const t = part.trim().replace(/^[([]|[)\]]$/g, "").trim();
        // Subscript and attribute targets assign through an existing object;
        // they do not create a local.
        if (t === "" || t.includes("[") || t.includes(".")) {
            continue;
        }
        const m = t.match(new RegExp(`^(\\*?)(${IDENT})$`));
        if (m) { found.push(m[2]); }
    }
    return found;
}

/**
 * Local names for the function whose `def` is at `defLine` (1-based), in slot
 * order: parameters first, then every other binding in source order.
 */
export function deriveLocalNames(source: string, defLine: number): string[] {
    const lines = source.split(/\r?\n/);
    const names: string[] = [];
    const seen = new Set<string>();
    const declaredElsewhere = new Set<string>();

    // Parameters, from the def line onward -- a signature may wrap.
    let sig = "";
    let depth = 0;
    for (let i = defLine - 1; i < lines.length; i++) {
        sig += decomment(lines[i]);
        for (const c of sig) {
            if (c === "(") { depth++; } else if (c === ")") { depth--; }
        }
        if (depth <= 0 && sig.includes("(")) { break; }
    }
    const open = sig.indexOf("(");
    const close = sig.lastIndexOf(")");
    if (open >= 0 && close > open) {
        // Split on top-level commas only, so a default like f(x, y=(1, 2)) is
        // not torn apart.
        const inner = sig.slice(open + 1, close);
        let level = 0, current = "";
        const params: string[] = [];
        for (const c of inner) {
            if ("([{".includes(c)) { level++; }
            if (")]}".includes(c)) { level--; }
            if (c === "," && level === 0) { params.push(current); current = ""; continue; }
            current += c;
        }
        params.push(current);
        for (const p of params) {
            const m = p.trim().match(new RegExp(`^\\*{0,2}(${IDENT})`));
            if (m) { pushName(names, seen, m[1]); }
        }
    }

    // Body: every binding form, in order.
    const defIndent = (lines[defLine - 1] ?? "").match(/^\s*/)![0].length;
    for (let i = defLine; i < lines.length; i++) {
        const raw = lines[i];
        if (raw.trim() === "") { continue; }
        const indent = raw.match(/^\s*/)![0].length;
        if (indent <= defIndent) { break; }          // left the function
        const line = decomment(raw).trim();
        if (line === "") { continue; }

        // A name declared global or nonlocal is not a local slot at all.
        const decl = line.match(/^(?:global|nonlocal)\s+(.*)$/);
        if (decl) {
            for (const n of decl[1].split(",")) { declaredElsewhere.add(n.trim()); }
            continue;
        }

        let m: RegExpMatchArray | null;
        if ((m = line.match(new RegExp(`^for\\s+(.+?)\\s+in\\s`)))) {
            for (const n of targetNames(m[1])) { pushName(names, seen, n); }
        } else if ((m = line.match(new RegExp(`^(?:async\\s+)?with\\s+(.+):$`)))) {
            for (const clause of m[1].split(",")) {
                const as = clause.match(new RegExp(`\\bas\\s+(${IDENT})\\s*$`));
                if (as) { pushName(names, seen, as[1]); }
            }
        } else if ((m = line.match(new RegExp(`^except\\b.*\\bas\\s+(${IDENT})\\s*:`)))) {
            pushName(names, seen, m[1]);
        } else if ((m = line.match(new RegExp(`^(?:def|class)\\s+(${IDENT})`)))) {
            pushName(names, seen, m[1]);
        } else if ((m = line.match(new RegExp(`^import\\s+(${IDENT})`)))) {
            pushName(names, seen, m[1]);
        } else if ((m = line.match(/^from\s+\S+\s+import\s+(.*)$/))) {
            for (const part of m[1].split(",")) {
                const as = part.trim().match(new RegExp(`(?:\\bas\\s+)?(${IDENT})\\s*$`));
                if (as) { pushName(names, seen, as[1]); }
            }
        } else if ((m = line.match(new RegExp(`^(${IDENT})\\s*(?:\\+|-|\\*|/|//|%|\\*\\*|>>|<<|&|\\||\\^)=`)))) {
            // Augmented assignment binds too, if the name is new to the scope.
            pushName(names, seen, m[1]);
        } else {
            // Plain assignment, including chained (a = b = expr), annotated
            // (a: int = 1) and unpacking (a, b = pair). Split before the first
            // top-level '=' that is not part of a comparison.
            const eq = line.search(/(?<![=!<>+\-*/%&|^])=(?!=)/);
            if (eq > 0) {
                for (const chunk of line.slice(0, eq).split("=")) {
                    const target = chunk.replace(/:\s*[^=]+$/, "");   // drop annotation
                    for (const n of targetNames(target)) { pushName(names, seen, n); }
                }
            }
        }
    }

    return names.filter((n) => !declaredElsewhere.has(n));
}

/**
 * Cross-check derived names against the ones the device read out of the
 * bytecode, which are authoritative.
 *
 * The device names the arguments and nothing else, so those are the overlap.
 * If they agree, the analysis is tracking the compiler's ordering for this
 * function and its answer for the later slots is worth using. If they do not,
 * something about this function defeated the analysis and every name past the
 * arguments is suspect, so none of them are used.
 */
export function verifyAgainstDevice(derived: string[], deviceNames: string[]): boolean {
    if (deviceNames.length > derived.length) {
        return false;
    }
    return deviceNames.every((n, i) => n === derived[i]);
}
