@echo off
setlocal
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo [ERROR] Run START_HERE.bat first.
  pause
  exit /b 1
)
".venv\Scripts\python.exe" maintenance.py
