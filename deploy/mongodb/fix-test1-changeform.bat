@echo off
REM Repoints the one saved changeForm still naming "Test 1.esp" at "Test 1 (1) (1).esp",
REM then restarts the game server. Run this from a normal shell or by double-clicking it,
REM NOT from the server-manager console tab (that relays game console commands, not shell).
setlocal
cd /d "%~dp0..\.."

echo ==========================================================
echo  Alduinak - repoint the orphaned Test 1 changeForm
echo ==========================================================
echo.
echo Repo: %CD%
echo.

echo [1/3] Stopping the game server (safe: a running server re-upserts forms)...
net stop AlduinakGameServer >nul 2>&1
echo.

echo [2/3] Repointing the changeForm...
node deploy\mongodb\repoint-changeforms.js "Test 1.esp" "Test 1 (1) (1).esp" --apply
if errorlevel 1 (
  echo.
  echo *** The migration FAILED - the server was NOT restarted. ***
  echo *** Copy everything above and send it back. ***
  pause
  exit /b 1
)
echo.

echo [3/3] Starting the game server...
net start AlduinakGameServer
echo.
echo Done. Give it ~20 seconds, then check: http://127.0.0.1:4000/api/status
echo It should say "online". If it says "offline", send back the last lines of
echo   C:\Users\Administrator\Desktop\logs\gameserver.log
echo.
pause
