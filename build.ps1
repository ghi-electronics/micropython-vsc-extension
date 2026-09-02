# Build the extension on Windows PowerShell.
#
#   .\build.ps1            compile TypeScript to out\
#   .\build.ps1 package    compile, then produce a .vsix to install
#
# Same steps as build.sh; kept separate only so neither shell needs the other.
param([string]$Task = "compile")

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (-not (Test-Path node_modules)) {
    Write-Host "==> installing dependencies"
    npm install
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

Write-Host "==> compiling"
npm run compile
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

if ($Task -eq "package") {
    # Fetched on demand rather than pinned as a devDependency: packaging is a
    # release step, not something every build needs installed for.
    Write-Host "==> packaging"
    npx --yes @vscode/vsce package --out micropython-sitcore-debug.vsix
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    Write-Host ""
    Write-Host "Install with:"
    Write-Host "  code --install-extension micropython-sitcore-debug.vsix"
}

Write-Host "==> done"
