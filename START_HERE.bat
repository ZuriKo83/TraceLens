@echo off
setlocal
cd /d "%~dp0"
where docker >nul 2>&1
if errorlevel 1 goto docker_missing
if not exist ".env" copy /Y ".env.example" ".env" >nul
docker compose up --build -d
if errorlevel 1 goto failed
start "" "http://localhost:8021"
echo Server started. Users open the TraceLens URL in their browser.
exit /b 0
:failed
echo Startup failed. Check the message above and docker compose logs web collector.
pause
exit /b 1
:docker_missing
echo Install and start Docker Desktop first.
pause
exit /b 1
