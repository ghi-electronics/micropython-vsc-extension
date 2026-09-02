@echo off
REM Build the MicroPython SITCore VS Code extension on Windows.
REM
REM   build-extension.bat            compile TypeScript to out\
REM   build-extension.bat package    compile, then produce an installable .vsix
REM
REM Only Node.js is required. The one native dependency, serialport, ships
REM prebuilt binaries for Windows, Linux and macOS, and all of them go into the
REM .vsix -- so a package built here installs on a customer's Linux or Mac
REM machine with no toolchain on their side.

setlocal
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
    echo ==^> packaging
    REM Fetched on demand rather than pinned as a devDependency: packaging is a
    REM release step, not something every build needs installed for.
    call npx --yes @vscode/vsce package --out micropython-sitcore-debug.vsix
    if errorlevel 1 exit /b 1
    echo.
    echo Built micropython-sitcore-debug.vsix
    echo Install with:
    echo     code --install-extension micropython-sitcore-debug.vsix
)

if /i not "%~1"=="package" (
    echo.
    echo Compiled to out\ -- enough to run with F5 in VS Code.
    echo To build an installable .vsix, run:  %~nx0 package
)

echo ==^> done
exit /b 0
