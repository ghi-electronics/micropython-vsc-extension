# Deploy-include test.
#
# launch.json for this project has:
#     "include": ["data/*.json", "**/*.csv"]
#
# so the deployer should push the .py, the .mpy, the matching JSON and CSV,
# and NOT the unmatched .txt. This program reads all three and prints the
# result, so a successful F5 confirms the include globs are working.

import json

print("--- data/settings.json ---")
with open("data/settings.json") as f:
    settings = json.load(f)
print("device_name:  ", settings["device_name"])
print("sample_rate_hz:", settings["sample_rate_hz"])
print("channels:     ", settings["channels"])

print()
print("--- log.csv ---")
with open("log.csv") as f:
    for line in f:
        print(line.rstrip())

print()
print("--- secret.txt (not in the include globs; open should fail) ---")
try:
    with open("secret.txt") as f:
        print("SURPRISE: secret.txt was deployed anyway ->", f.read().rstrip())
except OSError as e:
    print("OK, not deployed:", e)
