/**
 * Remove main.py from the device and restart it, so the board sits idle at the
 * REPL instead of running whatever was last deployed.
 *
 *   node test/clear_device.js
 */
const { DeviceLink, findPorts } = require("../out/deviceLink");

const Cond = { Stopped: 1, Attached: 4 };
const Reboot = { WaitForDebugger: 1 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    let link = await connect();
    if (!link) {
        console.log("no device found (board must be in VCP+VCP mode)");
        process.exit(1);
    }

    // Clear any debugger state first: a board halted at a breakpoint will not
    // run far enough to notice that main.py is gone.
    await link.setBreakpoints([]);
    await link.conditions(0, Cond.Stopped | Cond.Attached);

    const info = await link.fileCrc("main.py");
    if (info.rc === 0) {
        const rc = await link.deleteFile("main.py");
        console.log("deleted main.py:", rc === 0 ? "ok" : `failed (${rc})`);
    } else {
        console.log("no main.py on the device");
    }

    // Restart WITHOUT wait-for-debugger, so it boots straight to the REPL.
    console.log("restarting...");
    link.reboot(0);
    await link.close();
    await sleep(1500);

    link = await connect();
    if (link) {
        console.log("device is back and idle:", await link.ping() ? "responding" : "no reply");
        await link.close();
    } else {
        console.log("device did not come back -- unplug and replug if needed");
    }
}

main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
