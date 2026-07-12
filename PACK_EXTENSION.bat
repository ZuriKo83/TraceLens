@echo off
setlocal EnableExtensions
cd /d "%~dp0"
if errorlevel 1 goto path_error

title Package TraceLens Extension

if not exist "chrome_extension\manifest.json" goto missing_extension

set "OUTPUT=tracelens-extension-v1.0.7-cloudflare-https.zip"
if exist "%OUTPUT%" del /F /Q "%OUTPUT%"

where powershell.exe >nul 2>&1
if errorlevel 1 goto powershell_missing

echo Packaging TraceLens Chrome extension...
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "Compress-Archive -Path '.\chrome_extension\*' -DestinationPath '.\%OUTPUT%' -Force"
if errorlevel 1 goto error

if not exist "%OUTPUT%" goto error

echo Created: %OUTPUT%
pause
exit /b 0

:path_error
echo [ERROR] Could not open the project folder.
goto error_pause

:missing_extension
echo [ERROR] chrome_extension\manifest.json was not found.
goto error_pause

:powershell_missing
echo [ERROR] Windows PowerShell was not found.
goto error_pause

:error
echo [ERROR] Extension packaging failed.

:error_pause
pause
exit /b 1
