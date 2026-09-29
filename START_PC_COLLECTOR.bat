@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
if not exist "runtime\node.exe" (
  echo TraceLens PC collector package is incomplete.
  pause
  exit /b 1
)
if not defined TRACELENS_SERVER_URL set "TRACELENS_SERVER_URL=http://localhost:8021"
if not defined TRACELENS_CDP_ENDPOINT set "TRACELENS_CDP_ENDPOINT=http://127.0.0.1:9222"
for /f "delims=" %%A in ('powershell -NoProfile -Command "try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 '%TRACELENS_CDP_ENDPOINT%/json/version').StatusCode } catch { exit 1 }" 2^>nul') do set "CDP_READY=%%A"
if "%CDP_READY%"=="200" goto start_collector
tasklist /FI "IMAGENAME eq msedge.exe" 2>nul | find /I "msedge.exe" >nul
if not errorlevel 1 goto browser_running
tasklist /FI "IMAGENAME eq chrome.exe" 2>nul | find /I "chrome.exe" >nul
if not errorlevel 1 goto browser_running
tasklist /FI "IMAGENAME eq whale.exe" 2>nul | find /I "whale.exe" >nul
if not errorlevel 1 goto browser_running
set "EDGE_PATH=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if exist "%EDGE_PATH%" goto launch_edge
set "EDGE_PATH=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if exist "%EDGE_PATH%" goto launch_edge
echo No browser debugging connection found. Start an installed browser with local remote debugging enabled.
pause
exit /b 1
:launch_edge
echo Opening your existing Edge profile with local debugging enabled...
start "" "%EDGE_PATH%" --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 "%TRACELENS_SERVER_URL%/app"
timeout /t 3 /nobreak >nul
goto start_collector
:browser_running
echo A browser is already running without a debugging connection.
echo Close all browser windows, then run this file again. Existing browser sessions are not copied.
pause
exit /b 1
:start_collector
echo TraceLens server: %TRACELENS_SERVER_URL%
echo Browser connection: %TRACELENS_CDP_ENDPOINT%
"runtime\node.exe" "local_collector\attach.mjs"
pause
