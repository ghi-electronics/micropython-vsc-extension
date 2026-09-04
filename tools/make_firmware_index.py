#!/usr/bin/env python3
"""
Build micropython_firmware.json, the firmware index the extension reads.

The index deliberately has the same shape as tinyclr_firmware.json, which is
already published beside it on the GHI website: schemaVersion, a families
array, usb vid/pid as hex strings, site-relative url, md5.  Two products
publishing firmware identically means one set of website tooling.

It also does the ESP32 merge.  An esp-idf build leaves three images at three
flash offsets; the extension only ever writes one artifact, so they are
combined here into a single image for offset 0 -- the same thing
`esptool --merge-bin` does, but without needing esptool installed.

Usage:
    python make_firmware_index.py --root <path to micropython fork>
    python make_firmware_index.py --root ... --out /path/to/micropython_firmware.json

The version string is taken from git describe, so it matches exactly what the
board reports at the REPL and a host can compare the two without guessing.
"""

import argparse
import hashlib
import json
import os
import subprocess
import sys

# Where published firmware lives on the website, matching tinyclr's /bin/fw.
PUBLISH_DIR = "/bin/fw"

# One entry per shipped board.
#
# "artifact" is relative to the micropython root.  "esp_parts" replaces it for
# esp32, where the artifact has to be merged first.  "publish" is the file name
# on the website; {version} is substituted.
BOARDS = [
    {
        "id": "RPI_PICO",
        "name": "Raspberry Pi Pico",
        "kind": "uf2-drive",
        "bootloader": {"boardId": "RPI-RP2"},
        "artifact": "ports/rp2/build-RPI_PICO/firmware.uf2",
        "publish": "micropython-rpi-pico-v{version}.uf2",
    },
    {
        "id": "RPI_PICO2",
        "name": "Raspberry Pi Pico 2",
        "kind": "uf2-drive",
        "bootloader": {"boardId": "RP2350"},
        "artifact": "ports/rp2/build-RPI_PICO2/firmware.uf2",
        "publish": "micropython-rpi-pico2-v{version}.uf2",
    },
    {
        "id": "ADAFRUIT_QTPY_RP2040",
        "name": "Adafruit QT Py RP2040",
        "kind": "uf2-drive",
        "bootloader": {"boardId": "RPI-RP2"},
        "artifact": "ports/rp2/build-ADAFRUIT_QTPY_RP2040/firmware.uf2",
        "publish": "micropython-qtpy-rp2040-v{version}.uf2",
    },
    {
        "id": "ESP32_GENERIC_S2",
        "name": "ESP32-S2",
        "kind": "esp-rom",
        "bootloader": {"usb": {"vid": "0x303A", "pid": "0x0002"}},
        "address": 0,
        # Offsets come from the build's own flash_args; keep them in step if the
        # partition layout ever changes.
        "esp_parts": [
            (0x1000, "ports/esp32/build-ESP32_GENERIC_S2/bootloader/bootloader.bin"),
            (0x8000, "ports/esp32/build-ESP32_GENERIC_S2/partition_table/partition-table.bin"),
            (0x10000, "ports/esp32/build-ESP32_GENERIC_S2/micropython.bin"),
        ],
        "merged": "ports/esp32/build-ESP32_GENERIC_S2/micropython-merged.bin",
        "publish": "micropython-esp32-s2-v{version}.bin",
    },
]


def git_version(root):
    """The version the firmware itself reports.

    --tags matters: this fork's v1.29.0 is a lightweight tag, and plain
    `git describe` skips those and reports a v1.15 base instead.
    """
    out = subprocess.check_output(
        ["git", "describe", "--tags", "--always",
         "--match", "v[1-9].*", "--abbrev=10"],
        cwd=root, universal_newlines=True).strip()
    return out[1:] if out.startswith("v") else out


def merge_esp(root, parts, dest):
    """Combine the esp-idf images into one, padding gaps with erased flash."""
    blob = bytearray()
    for addr, rel in parts:
        path = os.path.join(root, rel)
        if not os.path.exists(path):
            return None
        if len(blob) > addr:
            raise SystemExit("esp images overlap at 0x%x" % addr)
        blob.extend(b"\xff" * (addr - len(blob)))
        with open(path, "rb") as f:
            blob.extend(f.read())
    full = os.path.join(root, dest)
    with open(full, "wb") as f:
        f.write(blob)
    return full


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--root", required=True,
                    help="path to the micropython fork")
    ap.add_argument("--out", default="micropython_firmware.json",
                    help="where to write the index")
    ap.add_argument("--version", default=None,
                    help="override the version string (default: git describe)")
    ap.add_argument("--date", default=None,
                    help="publication date (default: today)")
    ap.add_argument("--publish-to", default=None, metavar="DIR",
                    help="also copy the artifacts and the index into DIR, named "
                         "exactly as the index says (the website's static/bin/fw)")
    args = ap.parse_args()

    root = os.path.abspath(args.root)
    if not os.path.isdir(os.path.join(root, "py")):
        sys.exit("%s does not look like a micropython tree" % root)

    version = args.version or git_version(root)
    if args.date:
        date = args.date
    else:
        import datetime
        date = datetime.date.today().isoformat()

    families = []
    missing = []
    # (local build output, name it is published under) for --publish-to.
    to_publish = []

    for board in BOARDS:
        if "esp_parts" in board:
            path = merge_esp(root, board["esp_parts"], board["merged"])
            if path is None:
                missing.append(board["id"])
                continue
        else:
            path = os.path.join(root, board["artifact"])
            if not os.path.exists(path):
                missing.append(board["id"])
                continue

        with open(path, "rb") as f:
            data = f.read()

        entry = {
            "id": board["id"],
            "name": board["name"],
            "kind": board["kind"],
            "bootloader": board["bootloader"],
            "version": version,
            "date": date,
            "url": "%s/%s" % (PUBLISH_DIR, board["publish"].format(version=version)),
            "md5": hashlib.md5(data).hexdigest().upper(),
            "size": len(data),
        }
        if "address" in board:
            entry["address"] = board["address"]
        families.append(entry)
        to_publish.append((path, os.path.basename(entry["url"])))

        print("  %-24s %8d bytes  %s" % (board["id"], len(data), entry["md5"]))
        print("  %-24s %s" % ("", os.path.basename(entry["url"])))

    if not families:
        sys.exit("no firmware found under %s -- build first" % root)

    index = {
        "schemaVersion": 1,
        "source": "DebuggerExtension/micropython-vsc-extension/tools/make_firmware_index.py",
        "families": families,
    }
    with open(args.out, "w") as f:
        json.dump(index, f, indent=2)
        f.write("\n")

    print("\nwrote %s (%d families, version %s)" % (args.out, len(families), version))
    if missing:
        print("not built, so omitted: %s" % ", ".join(missing))

    if args.publish_to:
        import shutil
        dest = os.path.abspath(args.publish_to)
        if not os.path.isdir(dest):
            sys.exit("--publish-to: %s is not a directory" % dest)

        print("\npublishing to %s" % dest)
        for src, name in to_publish:
            target = os.path.join(dest, name)
            shutil.copyfile(src, target)
            # Re-hash what actually landed: a copy that silently truncated would
            # otherwise be published with the digest of the file it came from,
            # and the extension would reject every download from then on.
            with open(target, "rb") as f:
                got = hashlib.md5(f.read()).hexdigest().upper()
            want = next(x["md5"] for x in families
                        if os.path.basename(x["url"]) == name)
            status = "ok" if got == want else "MISMATCH"
            print("  %-56s %s" % (name, status))
            if got != want:
                sys.exit("copy of %s does not match its index entry" % name)

        index_name = os.path.basename(args.out)
        shutil.copyfile(args.out, os.path.join(dest, index_name))
        print("  %-56s ok" % index_name)


if __name__ == "__main__":
    main()
