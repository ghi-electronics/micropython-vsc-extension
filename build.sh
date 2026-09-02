#!/bin/sh
# Build the extension. Works on Linux, macOS, and Windows under Git Bash/WSL.
#
#   ./build.sh          compile TypeScript to out/
#   ./build.sh package  compile, then produce a .vsix to install
#
# There is nothing platform-specific here: the whole toolchain is npm and
# TypeScript. build.ps1 is the same thing for PowerShell.
set -e

cd "$(dirname "$0")"

if [ ! -d node_modules ]; then
    echo "==> installing dependencies"
    npm install
fi

echo "==> compiling"
npm run compile

if [ "$1" = "package" ]; then
    # Fetched on demand rather than pinned as a devDependency: packaging is a
    # release step, not something every build needs installed for.
    echo "==> packaging"
    npx --yes @vscode/vsce package --out micropython-sitcore-debug.vsix
    echo
    echo "Install with:"
    echo "  code --install-extension micropython-sitcore-debug.vsix"
fi

echo "==> done"
