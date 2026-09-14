# deploy-data-files

Verifies that `launch.json`'s `include` field pushes the right data files to
the board and skips everything else. `.py` and `.mpy` always deploy; anything
else has to be listed.

## Files in this project

    main.py               deploys (Python source, always)
    data/settings.json    deploys via "data/*.json"
    log.csv               deploys via "**/*.csv"
    secret.txt            does NOT deploy -- not matched by any include glob

## What to do

Press **F5**. The Debug Console should print, in order:

- The parsed contents of `data/settings.json` (`device_name`, `sample_rate_hz`, `channels`)
- The three lines of `log.csv`
- A friendly `OK, not deployed` message for `secret.txt`

## What each result tells you

| Debug Console shows | Meaning |
|---|---|
| Both JSON and CSV read cleanly | `include` globs work, deploy respects them |
| JSON or CSV read raises `OSError` | The matching include glob is not deploying that file |
| `secret.txt` reads its contents | The deploy is copying files past what `include` lists |

## Trying variations

Edit `include` in `.vscode/launch.json`:

- **`["**/*.txt"]`** -- now `secret.txt` deploys and prints its content, and the JSON/CSV reads fail
- **`[]`** -- only `main.py` deploys, all three data reads fail
- **`["data/*.json", "**/*.csv", "*.txt"]`** -- all three files deploy, no failures

Each edit changes what F5 pushes without touching any code.
