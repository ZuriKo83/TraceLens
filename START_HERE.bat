@echo off
setlocal EnableExtensions
cd /d "%~dp0"
if errorlevel 1 goto path_error

title TraceLens

if not exist "requirements.txt" goto missing_project
if not exist "app\main.py" goto missing_project
if not exist "tools\sync_admin_env.py" goto missing_project

if not exist ".env" (
    if exist ".env.example" copy /Y ".env.example" ".env" >nul
)

set "PYTHON_CMD="
where py >nul 2>&1
if not errorlevel 1 set "PYTHON_CMD=py -3"

if not defined PYTHON_CMD (
    where python >nul 2>&1
    if not errorlevel 1 set "PYTHON_CMD=python"
)

if not defined PYTHON_CMD goto python_missing

echo [0/4] Updating administrator settings...
if errorlevel 1 goto error

rem Preserve an existing database from the previous product name.
if exist "footprint.db" if not exist "tracelens.db" (
    copy /Y "footprint.db" "tracelens.db" >nul
)

if not exist ".venv\Scripts\python.exe" (
    echo [1/4] Creating Python virtual environment...
    %PYTHON_CMD% -m venv ".venv"
    if errorlevel 1 goto error
) else (
    echo [1/4] Python virtual environment already exists.
)

echo [2/4] Installing dependencies...
".venv\Scripts\python.exe" -m pip install -r "requirements.txt"
if errorlevel 1 goto error

echo [3/4] Starting TraceLens services...
start "TraceLens Web" cmd.exe /k ""%CD%\.venv\Scripts\python.exe" -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8021"
start "TraceLens Worker" cmd.exe /k ""%CD%\.venv\Scripts\python.exe" worker.py"
start "TraceLens Maintenance" cmd.exe /k ""%CD%\.venv\Scripts\python.exe" maintenance.py"
if errorlevel 1 goto error

timeout /t 3 /nobreak >nul

echo [4/4] Opening TraceLens...
start "" "http://localhost:8021"

echo.
echo TraceLens started.
exit /b 0

:path_error
echo [ERROR] Could not open the project folder.
goto error_pause

:missing_project
echo [ERROR] Required project files were not found.
echo Put START_HERE.bat in the project root folder.
goto error_pause

:python_missing
echo [ERROR] Python was not found.
echo Install Python 3.10 or newer and enable Add Python to PATH.
goto error_pause

:error
echo [ERROR] Setup or startup failed. Review the message above.

:error_pause
pause
exit /b 1
