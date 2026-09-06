@echo off
REM Repairs inventory baseIds stored as BSON doubles, then restarts the game server.
REM Run from a normal shell or by double-clicking it, NOT from the server-manager
REM console tab (that relays game console commands, not shell).
setlocal
cd /d "%~dp0..\.."

echo ==========================================================
echo  Alduinak - repair double-typed inventory baseIds
echo ==========================================================
echo.
echo Repo: %CD%
echo.

echo [1/3] Stopping the game server...
net stop AlduinakGameServer >nul 2>&1
echo.

echo [2/3] Retyping the affected changeForms...
node deploy\mongodb\retype-inventory-numbers.js --apply
if errorlevel 1 (
  echo.
  echo *** The repair FAILED - the server was NOT restarted. ***
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
