@echo off
setlocal

:: ============================================================
::   AlduinakManager agent installer (web Server Manager jobs).
::   Loopback only, runs as the Administrator account.
:: ============================================================

set "MANAGER_DIR=%~dp0"
if "%MANAGER_DIR:~-1%"=="\" set "MANAGER_DIR=%MANAGER_DIR:~0,-1%"
set "LOG_DIR=C:\logs"
set "NSSM=C:\tools\nssm\nssm.exe"
set "SERVICE=AlduinakManager"
set "EXTRA_PATH=%USERPROFILE%\AppData\Roaming\npm"

net session >nul 2>&1
if errorlevel 1 (
    echo Requesting administrator rights...
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

if not exist "%NSSM%" (
    echo [ERROR] %NSSM% not found. Run skymp5-backend\Setup-Backend.bat first, it installs NSSM.
    pause
    exit /b 1
)
for /f "delims=" %%p in ('where node') do (
    set "NODE_EXE=%%p"
    goto :node_found
)
echo [ERROR] Node.js was not found on PATH.
pause
exit /b 1
:node_found

findstr /b /c:"MANAGER_AGENT_SECRET=" "%MANAGER_DIR%\..\skymp5-backend\.env" >nul 2>&1
if errorlevel 1 (
    echo [ERROR] MANAGER_AGENT_SECRET is missing from skymp5-backend\.env. Add it first, see docs\docs_web_server_manager.md.
    pause
    exit /b 1
)

if not exist "%LOG_DIR%\manager" mkdir "%LOG_DIR%\manager"
echo Configuring service: %SERVICE%
"%NSSM%" stop %SERVICE% >nul 2>&1
"%NSSM%" remove %SERVICE% confirm >nul 2>&1
"%NSSM%" install %SERVICE% "%NODE_EXE%" "src\agent.js"
"%NSSM%" set %SERVICE% AppDirectory "%MANAGER_DIR%"
"%NSSM%" set %SERVICE% DisplayName "Alduinak Manager Agent"
"%NSSM%" set %SERVICE% Description "Loopback job agent for the dashboard Server Manager (127.0.0.1 only)"
"%NSSM%" set %SERVICE% AppStdout "%LOG_DIR%\manager-agent.log"
"%NSSM%" set %SERVICE% AppStderr "%LOG_DIR%\manager-agent-err.log"
"%NSSM%" set %SERVICE% AppRotateFiles 1
"%NSSM%" set %SERVICE% AppRotateBytes 10485760
"%NSSM%" set %SERVICE% AppEnvironmentExtra "ALDUINAK_NO_AUTO_INSTALL=1" "ALDUINAK_EXTRA_PATH=%EXTRA_PATH%"
"%NSSM%" set %SERVICE% Start SERVICE_AUTO_START
"%NSSM%" set %SERVICE% AppThrottle 5000

echo.
echo The service must log on as .\Administrator so builds see the same yarn and caches as manual builds.
echo In the window that opens, go to the "Log on" tab, choose "This account", enter .\Administrator
echo and its password, then press "Edit service".
"%NSSM%" edit %SERVICE%

echo Starting %SERVICE%...
"%NSSM%" start %SERVICE%
"%NSSM%" status %SERVICE%
echo.
echo Logs:   %LOG_DIR%\manager-agent.log and manager-agent-err.log
echo Jobs:   %LOG_DIR%\manager\jobs   Audit: %LOG_DIR%\manager\audit-agent.jsonl
pause
