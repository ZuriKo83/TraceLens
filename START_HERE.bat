@echo off
setlocal
cd /d "%~dp0"
where docker >nul 2>&1
if errorlevel 1 goto docker_missing
where node >nul 2>&1
if errorlevel 1 goto node_missing
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)"
if errorlevel 1 goto node_missing
if not exist ".env" copy /Y ".env.example" ".env" >nul

echo Select collection browser:
echo 1. Microsoft Edge (installed)
echo 2. Google Chrome (installed)
echo 3. Firefox (managed, downloaded on first run)
echo 4. Chromium (managed, downloaded on first run)
choice /c 1234 /n /m "Browser [1-4]: "
set "TRACELENS_BROWSER=chromium"
if errorlevel 4 goto selected
set "TRACELENS_BROWSER=firefox"
if errorlevel 3 goto selected
set "TRACELENS_BROWSER=chrome"
if errorlevel 2 goto selected
set "TRACELENS_BROWSER=edge"
:selected
docker compose up --build -d
if errorlevel 1 goto failed
pushd local_collector
call npm ci --no-audit --no-fund
if errorlevel 1 goto install_failed
if "%TRACELENS_BROWSER%"=="firefox" call npx --no-install playwright install firefox
if errorlevel 1 goto install_failed
if "%TRACELENS_BROWSER%"=="chromium" call npx --no-install playwright install chromium
if errorlevel 1 goto install_failed
node index.mjs --browser %TRACELENS_BROWSER%
if errorlevel 1 goto install_failed
popd
exit /b 0
:install_failed
popd
:failed
echo Startup failed. Check the message above and docker compose logs web.
pause
exit /b 1
:docker_missing
echo Install and start Docker Desktop first.
pause
exit /b 1
:node_missing
echo Install Node.js 22 or newer, then reopen this file.
pause
exit /b 1
