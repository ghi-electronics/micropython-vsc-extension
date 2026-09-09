@echo off
REM Build the MicroPython Debugger VS Code extension on Windows.
REM
REM   build-extension.bat            compile TypeScript to out\
REM   build-extension.bat package    compile, then produce an installable .vsix
REM
REM Only Node.js is required. The one native dependency, serialport, ships
REM prebuilt binaries for Windows, Linux and macOS, and all of them go into the
REM .vsix -- so a package built here installs on a customer's Linux or Mac
REM machine with no toolchain on their side.

setlocal enabledelayedexpansion
cd /d "%~dp0"

where npm >nul 2>&1
if errorlevel 1 (
    echo ERROR: npm was not found on PATH.
    echo Install Node.js LTS from https://nodejs.org and open a new terminal.
    exit /b 1
)

if not exist node_modules (
    echo ==^> installing dependencies
    call npm install
    if errorlevel 1 exit /b 1
)

echo ==^> compiling
call npm run compile
if errorlevel 1 exit /b 1

if /i "%~1"=="package" (
    REM Name the package exactly as the Marketplace names its downloads:
    REM   <publisher>.<name>-<version>.vsix
    REM so a file built here and one downloaded from the Marketplace are
    REM indistinguishable. Every part comes from package.json, so the name can
    REM never drift from the identity it claims. Read via a temp file rather
    REM than a for/f capture, which is easy to get subtly wrong with quoting.
    call node -p "var p=require('./package.json');p.publisher+'.'+p.name+'-'+p.version" > "%TEMP%\mpy_vsix_id.txt"
    set "VSIXID="
    if exist "%TEMP%\mpy_vsix_id.txt" set /p VSIXID=<"%TEMP%\mpy_vsix_id.txt"
    del "%TEMP%\mpy_vsix_id.txt" >nul 2>&1
    if not defined VSIXID (
        echo ERROR: could not read the identity from package.json.
        exit /b 1
    )
    set "VSIX=!VSIXID!.vsix"
    echo ==^> packaging !VSIX!
    REM Fetched on demand rather than pinned as a devDependency: packaging is a
    REM release step, not something every build needs installed for.
    call npx --yes @vscode/vsce package --out "!VSIX!"
    if errorlevel 1 exit /b 1
    echo.
    echo Built !VSIX!
    echo Install with:
    REM --force matters: the version in package.json does not change between
    REM builds, so without it VS Code sees the same version already installed
    REM and silently skips -- which looks exactly like the new code not working.
    echo     code --install-extension !VSIX! --force
)

if /i not "%~1"=="package" (
    echo.
    echo Compiled to out\ -- enough to run with F5 in VS Code.
    echo To build an installable .vsix, run:  %~nx0 package
)

echo ==^> done
exit /b 0
