@echo off
setlocal
cd /d "%~dp0"

where docker >nul 2>&1
if errorlevel 1 (
  echo Docker Desktop was not found. Install or start Docker Desktop first.
  pause
  exit /b 1
)

if not exist ".env" (
  copy /Y ".env.example" ".env" >nul
  echo Created .env from the local development example.
)

docker compose up --build -d
if errorlevel 1 (
  echo Docker Compose failed. Check Docker Desktop and run docker compose logs web.
  pause
  exit /b 1
)

start "" "http://localhost:8021"
echo TraceLens is starting at http://localhost:8021
echo If the page is not ready, run docker compose logs -f web.
exit /b 0
