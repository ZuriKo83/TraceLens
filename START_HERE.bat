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

if not defined TRACELENS_BROWSER (
  if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" set "TRACELENS_BROWSER=edge"
  if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" set "TRACELENS_BROWSER=edge"
  if not defined TRACELENS_BROWSER if exist "%LocalAppData%\Microsoft\Edge\Application\msedge.exe" set "TRACELENS_BROWSER=edge"
  if not defined TRACELENS_BROWSER if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "TRACELENS_BROWSER=chrome"
  if not defined TRACELENS_BROWSER if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "TRACELENS_BROWSER=chrome"
  if not defined TRACELENS_BROWSER if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" set "TRACELENS_BROWSER=chrome"
  if not defined TRACELENS_BROWSER set "TRACELENS_BROWSER=chromium"
)
echo Collection browser: %TRACELENS_BROWSER%
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
