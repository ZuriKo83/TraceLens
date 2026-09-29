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
set "TRACELENS_BROWSER=edge"
if not exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" if not exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" set "TRACELENS_BROWSER=chrome"
echo TraceLens server: %TRACELENS_SERVER_URL%
echo TraceLens browser: %TRACELENS_BROWSER% (separate saved profile)
"runtime\node.exe" "local_collector\index.mjs" --browser=%TRACELENS_BROWSER%
pause
