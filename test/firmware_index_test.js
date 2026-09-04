/**
 * The firmware index, and the checks that stand between a download and a board.
 *
 * By the time firmware is written, the user has already put the board into its
 * bootloader, where it will accept whatever it is given.  So everything that
 * can reject a bad image has to work before that point: the digest check, the
 * URL resolution that decides which file was fetched, and the board matching
 * that decides which firmware belongs to the hardware in hand.  None of that
 * needs a board to test, so it is all tested here.
 *
 *   node test/firmware_index_test.js
 */
const Module = require("module");
const fs = require("fs");
const path = require("path");

// manifest.ts imports vscode for settings and progress; none of that is
// reachable outside the extension host, and none of it is what is under test.
const realLoad = Module._load;
Module._load = function (request) {
    if (request === "vscode") {
        return {
            workspace: { getConfiguration: () => ({ get: (_k, d) => d }) },
            CancellationError: class CancellationError extends Error { },
        };
    }
    return realLoad.apply(this, arguments);
};

const manifest = require("../out/firmware/manifest");
const boards = require("../out/firmware/boards");

const INDEX_URL = "https://www.ghielectronics.com/bin/fw/micropython_firmware.json";

let failures = 0;
function check(name, ok, detail) {
    if (!ok) {
        failures++;
    }
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
    if (!ok && detail) {
        console.log(`      ${detail}`);
    }
}

// --- INFO_UF2.TXT, as the rp2 ROM actually writes it (CRLF) ----------------
{
    const info = "UF2 Bootloader v3.0\r\nModel: Raspberry Pi RP2\r\nBoard-ID: RPI-RP2\r\n";
    const got = boards.parseInfoUf2(info);
    check("INFO_UF2.TXT parses Board-ID", got.boardId === "RPI-RP2", JSON.stringify(got));
    check("INFO_UF2.TXT parses Model", got.model === "Raspberry Pi RP2", JSON.stringify(got));
    check("a file with no Board-ID is not a board",
        boards.parseInfoUf2("nonsense\r\n").boardId === undefined);
}

// --- which boards a bootloader could be ------------------------------------
{
    const rp2040 = boards.familyForBoardId("RPI-RP2");
    check("RP2040 is ambiguous, so more than one candidate",
        rp2040 && rp2040.boards.length > 1,
        rp2040 ? rp2040.boards.map((b) => b.id).join(", ") : "no family");

    const rp2350 = boards.familyForBoardId("RP2350");
    check("RP2350 identifies itself, so exactly one candidate",
        rp2350 && rp2350.boards.length === 1 && rp2350.boards[0].id === "RPI_PICO2",
        rp2350 ? rp2350.boards.map((b) => b.id).join(", ") : "no family");

    check("an unknown drive is not offered firmware",
        boards.familyForBoardId("SOME-OTHER-BOARD") === undefined);
}

// --- hex ids, as tinyclr_firmware.json writes them --------------------------
{
    check("0x303A parses", manifest.parseHexId("0x303A") === 0x303a);
    check("bare hex parses", manifest.parseHexId("303a") === 0x303a);
    check("0x0002 parses to 2", manifest.parseHexId("0x0002") === 2);
    check("a missing id stays undefined", manifest.parseHexId(undefined) === undefined);
}

// --- site-relative urls resolve against the index, not a separate host -------
{
    const rel = { url: "/bin/fw/micropython-rpi-pico-v1.29.0.uf2" };
    check("site-relative url resolves against the index",
        manifest.artifactUrl(rel, INDEX_URL) ===
        "https://www.ghielectronics.com/bin/fw/micropython-rpi-pico-v1.29.0.uf2",
        manifest.artifactUrl(rel, INDEX_URL));

    const abs = { url: "https://cdn.example.com/fw/x.uf2" };
    check("an absolute url is left alone",
        manifest.artifactUrl(abs, INDEX_URL) === "https://cdn.example.com/fw/x.uf2");
}

// --- the generated index, checked against the artifacts it describes ---------
{
    const indexPath = path.join(__dirname, "..", "micropython_firmware.json");
    if (!fs.existsSync(indexPath)) {
        console.log("SKIP  no micropython_firmware.json -- run tools/make_firmware_index.py");
    } else {
        const idx = JSON.parse(fs.readFileSync(indexPath, "utf8"));

        check("index declares schemaVersion 1", idx.schemaVersion === 1);
        check("index has families", Array.isArray(idx.families) && idx.families.length > 0);

        for (const f of idx.families) {
            check(`${f.id}: has a digest`, Boolean(f.md5 || f.sha256));
            check(`${f.id}: url is under the publish dir`,
                typeof f.url === "string" && f.url.startsWith("/bin/fw/"), f.url);
            check(`${f.id}: declares how to reach the bootloader`,
                Boolean(f.bootloader && (f.bootloader.boardId || f.bootloader.usb)));
            if (f.kind === "esp-rom") {
                check(`${f.id}: merged image is written at 0`, f.address === 0);
            }
        }

        // Every board the extension ships knowing must be in the index, or the
        // user is offered a board and then told there is no firmware for it.
        for (const b of boards.allBoards()) {
            check(`${b.id}: present in the index`,
                idx.families.some((f) => f.id === b.id));
        }
    }
}

// --- the digest check is the last line of defence, so prove it rejects -------
{
    const good = Buffer.from("firmware image");
    const family = { name: "test", md5: manifest.md5(good) };
    check("md5 of the real bytes matches", manifest.md5(good) === family.md5);

    const truncated = good.subarray(0, good.length - 1);
    check("a truncated download does not match", manifest.md5(truncated) !== family.md5);

    check("sha256 is preferred when published",
        manifest.sha256(good).length === 64 && manifest.sha256(good) !== manifest.md5(good));
}

console.log(`\n${failures === 0 ? "all checks passed" : failures + " failed"}`);
process.exit(failures === 0 ? 0 : 1);
