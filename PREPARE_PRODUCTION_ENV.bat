@echo off
setlocal EnableExtensions
cd /d "%~dp0"
if not exist ".env.production.example" goto missing
copy /Y ".env.production.example" ".env" >nul
echo.
echo Created .env for https://tracelens.kr via Cloudflare Tunnel
echo Edit SMTP_PASSWORD and SESSION_SECRET before starting the server.
pause
exit /b 0
:missing
echo [ERROR] .env.production.example was not found.
pause
exit /b 1
