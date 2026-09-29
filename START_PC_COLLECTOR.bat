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
echo TraceLens server: %TRACELENS_SERVER_URL%
echo Browser connection: %TRACELENS_CDP_ENDPOINT%
"runtime\node.exe" "local_collector\attach.mjs"
pause
