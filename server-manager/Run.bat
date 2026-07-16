@echo off
::  Launch the Alduinak Server Manager (everyday use).
::  Self-elevates so the Console tab can control the Windows
::  services. Run setup.bat once first to install dependencies.

net session >nul 2>&1
if errorlevel 1 (
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

cd /d "%~dp0"

if not exist "node_modules\electron\dist\electron.exe" (
    echo Electron is not installed yet - run setup.bat first.
    pause
    exit /b 1
)

call npm start
