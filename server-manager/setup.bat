@echo off
setlocal
cd /d "%~dp0"

:: ============================================================
::  SkyRP Server Manager — robust dependency install.
::  Fixes the common "Electron failed to install correctly"
::  error by reinstalling cleanly and verifying the Electron
::  binary actually downloaded.
:: ============================================================

echo === SkyRP Server Manager setup ===
echo.

where node >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js was not found on PATH. Install the LTS from https://nodejs.org
    pause
    exit /b 1
)

echo Removing any previous install...
if exist node_modules rmdir /s /q node_modules
if exist package-lock.json del /q package-lock.json

echo Installing dependencies (this downloads the Electron runtime)...
call npm install --foreground-scripts
if errorlevel 1 (
    echo [ERROR] npm install failed - see output above.
    pause
    exit /b 1
)

:: Electron's binary lands here; if it's missing the postinstall was skipped
:: or blocked, so run its installer directly to surface the real error.
if not exist "node_modules\electron\dist\electron.exe" (
    echo.
    echo Electron binary missing - forcing its download...
    node "node_modules\electron\install.js"
)

if not exist "node_modules\electron\dist\electron.exe" (
    echo.
    echo [ERROR] Electron still did not download. If this machine is behind a
    echo firewall/proxy, set a mirror and run this script again:
    echo.
    echo     set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
    echo.
    pause
    exit /b 1
)

echo.
echo Done. Start the manager with:  npm start
echo (Run as Administrator so it can control the Windows services.)
pause
