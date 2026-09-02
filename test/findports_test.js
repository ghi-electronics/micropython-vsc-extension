/**
 * Port discovery, on all three platforms, without a board.
 *
 * findPorts() has to tell the board's two CDC interfaces apart, and every OS
 * spells that differently -- Windows in the device instance path, Linux in the
 * by-id symlink, macOS not at all. Only one of those can be checked on the
 * machine this is developed on, so the other two are checked here against the
 * shapes their platform actually reports.
 *
 *   node test/findports_test.js
 */
const Module = require("module");

// Stand in for the serialport module before deviceLink lazily requires it.
let fakePorts = [];
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === "serialport") {
        return { SerialPort: { list: async () => fakePorts } };
    }
    return realLoad.apply(this, arguments);
};

const { findPorts } = require("../out/deviceLink");

const VID = "1b9f";
const PID = "f105";

const CASES = [
    {
        name: "Windows: interface number in the device instance path",
        ports: [
            { path: "COM3", vendorId: VID, productId: PID,
                pnpId: "USB\\VID_1B9F&PID_F105&MI_00\\6&1A2B3C&0&0000" },
            { path: "COM4", vendorId: VID, productId: PID,
                pnpId: "USB\\VID_1B9F&PID_F105&MI_02\\6&1A2B3C&0&0002" },
        ],
        expect: { repl: "COM3", debug: "COM4" },
    },
    {
        name: "Linux: interface number in the by-id name",
        ports: [
            { path: "/dev/ttyACM0", vendorId: VID, productId: PID,
                pnpId: "usb-MicroPython_Board_in_FS_mode_deadbeef-if00" },
            { path: "/dev/ttyACM1", vendorId: VID, productId: PID,
                pnpId: "usb-MicroPython_Board_in_FS_mode_deadbeef-if02" },
        ],
        expect: { repl: "/dev/ttyACM0", debug: "/dev/ttyACM1" },
    },
    {
        name: "Linux: listed in reverse order, still resolved by interface",
        ports: [
            { path: "/dev/ttyACM1", vendorId: VID, productId: PID,
                pnpId: "usb-MicroPython_Board_in_FS_mode_deadbeef-if02" },
            { path: "/dev/ttyACM0", vendorId: VID, productId: PID,
                pnpId: "usb-MicroPython_Board_in_FS_mode_deadbeef-if00" },
        ],
        expect: { repl: "/dev/ttyACM0", debug: "/dev/ttyACM1" },
    },
    {
        name: "macOS: no interface metadata, fall back to enumeration order",
        ports: [
            { path: "/dev/tty.usbmodem14203", vendorId: VID, productId: PID },
            { path: "/dev/tty.usbmodem14201", vendorId: VID, productId: PID },
        ],
        // Sorted, so ...201 (interface 0) is the REPL and ...203 the debug
        // channel. The cu. siblings do not exist here, so the tty. names stand.
        expect: { repl: "/dev/tty.usbmodem14201", debug: "/dev/tty.usbmodem14203" },
    },
    {
        name: "other USB serial devices are ignored",
        ports: [
            { path: "/dev/ttyUSB0", vendorId: "0403", productId: "6001",
                pnpId: "usb-FTDI_FT232R-if00" },
            { path: "/dev/ttyACM0", vendorId: VID, productId: PID,
                pnpId: "usb-MicroPython_Board_in_FS_mode_deadbeef-if00" },
            { path: "/dev/ttyACM1", vendorId: VID, productId: PID,
                pnpId: "usb-MicroPython_Board_in_FS_mode_deadbeef-if02" },
        ],
        expect: { repl: "/dev/ttyACM0", debug: "/dev/ttyACM1" },
    },
    {
        name: "one interface only: no debug port, and no guessing",
        ports: [
            { path: "/dev/ttyACM0", vendorId: VID, productId: PID,
                pnpId: "usb-MicroPython_Board_in_FS_mode_deadbeef-if00" },
        ],
        expect: { repl: "/dev/ttyACM0", debug: undefined },
    },
    {
        name: "no board attached",
        ports: [],
        expect: { repl: undefined, debug: undefined },
    },
];

async function main() {
    let failures = 0;
    for (const c of CASES) {
        fakePorts = c.ports;
        const got = await findPorts();
        const ok = got.repl === c.expect.repl && got.debug === c.expect.debug;
        if (!ok) {
            failures++;
        }
        console.log(`${ok ? "PASS" : "FAIL"}  ${c.name}`);
        if (!ok) {
            console.log(`      expected repl=${c.expect.repl} debug=${c.expect.debug}`);
            console.log(`      got      repl=${got.repl} debug=${got.debug}`);
        }
    }
    console.log(`\n${CASES.length - failures}/${CASES.length} passed`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("ERROR:", e); process.exit(1); });
