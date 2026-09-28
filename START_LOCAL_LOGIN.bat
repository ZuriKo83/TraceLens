@echo off
setlocal
cd /d "%~dp0"
set "NODE_EXE=%~dp0node.exe"
if not exist "%NODE_EXE%" (
  where node >nul 2>&1
  if errorlevel 1 (
    echo TraceLens Windows bundle is incomplete. Download the ZIP artifact and extract all files first.
    pause
    exit /b 1
  )
  set "NODE_EXE=node"
)
"%NODE_EXE%" "%~dp0local_collector\interactive.mjs"
if errorlevel 1 pause
