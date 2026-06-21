@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"

:: ============================================================
::  SkyRP Server Manager — resilient dependency install.
::  Built for a flaky firewall: it tries several ways to get the
::  Electron runtime so a single failed download doesn't block you.
:: ============================================================

set "EL_VER=41.2.0"
set "EL_PKG=node_modules\electron"
set "EL_BIN=%EL_PKG%\dist\electron.exe"
set "EL_ZIP=electron-v%EL_VER%-win32-x64.zip"

echo === SkyRP Server Manager setup ===
echo.

where node >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js was not found on PATH. Install the LTS from https://nodejs.org
    pause
    exit /b 1
)

echo Installing npm dependencies...
:: The electron postinstall may fail behind the firewall; that is fine, the
:: fallbacks below recover the binary. So we don't hard-fail on npm here.
call npm install --foreground-scripts --no-audit --no-fund

if exist "%EL_BIN%" goto :done
if not exist "%EL_PKG%" (
    echo [ERROR] npm did not install the electron package at all - check npm output above.
    pause
    exit /b 1
)

echo.
echo Electron runtime missing - trying offline-friendly fallbacks...

:: 1) Reuse the launcher's Electron (same version, already on disk if you built it)
set "LAUNCHER_DIST=..\skymp5-launcher\node_modules\electron\dist"
if exist "%LAUNCHER_DIST%\electron.exe" (
    echo  - reusing Electron from the launcher install...
    xcopy /e /i /y /q "%LAUNCHER_DIST%" "%EL_PKG%\dist" >nul
    > "%EL_PKG%\path.txt" echo dist\electron.exe
    if exist "%EL_BIN%" goto :done
)

:: 2) Extract a zip you downloaded by hand and dropped next to this script
if exist "%EL_ZIP%" (
    echo  - extracting %EL_ZIP% ...
    powershell -NoProfile -Command "Expand-Archive -Force '%EL_ZIP%' '%EL_PKG%\dist'"
    > "%EL_PKG%\path.txt" echo dist\electron.exe
    if exist "%EL_BIN%" goto :done
)

:: 3) Retry the normal download a few times (the firewall is intermittent)
set /a tries=0
:retry
set /a tries+=1
echo  - download attempt !tries! of 5 ...
node "%EL_PKG%\install.js" 2>nul
if exist "%EL_BIN%" goto :done
if !tries! lss 5 ( timeout /t 6 >nul & goto :retry )

echo.
echo [ERROR] Could not obtain the Electron runtime through the firewall.
echo.
echo Manual fix - download this once (refresh until the firewall lets it through):
echo   https://github.com/electron/electron/releases/download/v%EL_VER%/%EL_ZIP%
echo   mirror: https://npmmirror.com/mirrors/electron/%EL_VER%/%EL_ZIP%
echo Save it as:
echo   %CD%\%EL_ZIP%
echo then run setup.bat again - it will extract it locally (no further download).
echo.
pause
exit /b 1

:done
echo.
echo Done. Electron is ready.
echo Launching the manager (Run.bat, which requests admin for service control)...
start "" "%~dp0Run.bat"
exit /b 0
