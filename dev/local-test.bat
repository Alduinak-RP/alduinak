@echo off
REM ============================================================================
REM  Alduinak local dev test: offline server + Skyrim, no VPS / OAuth / backend.
REM
REM  In offline mode the game server needs NO master API, NO backend, NO nginx.
REM  This copies a dev (offline) server-settings.json into the server dist,
REM  starts the server, writes an offline client settings file (profileId +
REM  127.0.0.1), and launches Skyrim through SKSE directly.
REM
REM  Prereqs on the dev box:
REM   - node on PATH
REM   - build/dist/server populated (scam_native.node + dist_back + gamemode.js)
REM   - a Skyrim install with the client files staged in its Data folder
REM     (copy build/dist/client/Data over the game Data, plus d3dx9_42.dll and
REM      SKSE in the game root). See dev/README-local-test.md.
REM
REM  Edit the three paths / ids below to match your machine, then run this file.
REM ============================================================================

setlocal

REM ---- CONFIG (edit these) ---------------------------------------------------
set "REPO=%~dp0.."
set "SERVER_DIR=%REPO%\build\dist\server"
set "GAME_DIR=C:\Alduinak\skyrim"
set "PROFILE_ID=1"
set "PORT=7777"
REM ----------------------------------------------------------------------------

if not exist "%SERVER_DIR%\dist_back\skymp5-server.js" (
  echo [dev] ERROR: server bundle not found at %SERVER_DIR%\dist_back\skymp5-server.js
  echo [dev] Build it first: cd skymp5-server ^&^& npm run build-ts
  exit /b 1
)
if not exist "%GAME_DIR%\skse64_loader.exe" (
  echo [dev] ERROR: skse64_loader.exe not found in %GAME_DIR%
  exit /b 1
)

REM 1) install the offline settings and clear stale merge caches
copy /y "%~dp0dev-server-settings.json" "%SERVER_DIR%\server-settings.json" >nul
del /q "%SERVER_DIR%\server-settings-dump.json" "%SERVER_DIR%\server-settings-merged.json" 2>nul

REM 2) start the server in its own window (CWD must be the server dir)
echo [dev] Starting offline server on port %PORT% ...
start "Alduinak Dev Server" cmd /k "cd /d "%SERVER_DIR%" && node dist_back\skymp5-server.js"

REM 3) wait for the HTTP UI (ui.ts: port 7777 -> 3000, otherwise port + 1)
echo [dev] Waiting for the server to come up ...
if "%PORT%"=="7777" ( set /a UIPORT=3000 ) else ( set /a UIPORT=%PORT%+1 )
:waitloop
powershell -NoProfile -Command "try{if((Test-NetConnection 127.0.0.1 -Port %UIPORT% -WarningAction SilentlyContinue).TcpTestSucceeded){exit 0}else{exit 1}}catch{exit 1}"
if errorlevel 1 ( timeout /t 1 /nobreak >nul & goto waitloop )
timeout /t 2 /nobreak >nul

REM 4) write the offline client settings (profileId + loopback, skip serverinfo)
set "PLUG=%GAME_DIR%\Data\Platform\Plugins"
if not exist "%PLUG%" mkdir "%PLUG%"
powershell -NoProfile -Command ^
  "$s=[ordered]@{ 'gameData'=[ordered]@{ 'profileId'=[int]$env:PROFILE_ID }; 'master'=''; 'server-ip'='127.0.0.1'; 'server-master-key'=$null; 'server-port'=[int]$env:PORT; 'server-info-ignore'=$true }; ($s | ConvertTo-Json -Depth 4) | Set-Content -Encoding UTF8 (Join-Path $env:PLUG 'skymp5-client-settings.txt')"

echo [dev] Wrote client settings (profileId=%PROFILE_ID%, 127.0.0.1:%PORT%).

REM 5) launch Skyrim via SKSE (cwd = game dir)
echo [dev] Launching Skyrim ...
start "" /d "%GAME_DIR%" "%GAME_DIR%\skse64_loader.exe"

endlocal
