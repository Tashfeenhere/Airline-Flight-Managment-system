@echo off
setlocal enabledelayedexpansion

echo =====================================================================
echo  Distributed Airline Inventory - Docker Orchestrator ^& Validator
echo =====================================================================
echo.

REM Auto-detect Docker Desktop binary in AppData or Program Files directory
if exist "%LOCALAPPDATA%\Programs\DockerDesktop\resources\bin\docker.exe" (
    set "PATH=%LOCALAPPDATA%\Programs\DockerDesktop\resources\bin;!PATH!"
)
if exist "%ProgramFiles%\Docker\Docker\resources\bin\docker.exe" (
    set "PATH=%ProgramFiles%\Docker\Docker\resources\bin;!PATH!"
)

where docker >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Docker command was not found on your system PATH.
    echo.
    echo To install Docker Desktop on Windows automatically:
    echo   1. Run this command in an Administrator PowerShell prompt:
    echo      winget install Docker.DockerDesktop
    echo   2. Reboot your computer when prompted to initialize Hyper-V / WSL2.
    echo   3. Launch Docker Desktop and rerun this script: .\docker-start.bat
    echo.
    pause
    exit /b 1
)

echo [1/5] Checking Docker daemon status...
docker info >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Docker CLI found, but Docker Daemon is not running.
    echo Please start Docker Desktop and wait until it is fully initialized.
    echo.
    pause
    exit /b 1
)

echo [OK] Docker daemon is running.
echo.

echo [2/5] Building and launching core infrastructure (Coordinator, Workers, Read-Model, Redis, PgBouncer, API, Frontend)...
docker compose up -d coordinator worker1 worker2 readmodel redis pgbouncer api frontend

echo.
echo [3/5] Waiting for datastores to reach healthy state and registering Citus workers...
timeout /t 8 /nobreak >nul
docker exec -i airline_coordinator psql -U airline -d airline_inventory -c "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_dist_node WHERE nodename = 'worker1') THEN PERFORM citus_add_node('worker1', 5432); END IF; IF NOT EXISTS (SELECT 1 FROM pg_dist_node WHERE nodename = 'worker2') THEN PERFORM citus_add_node('worker2', 5432); END IF; END $$;" >nul 2>nul

echo.
echo [4/5] Executing database schema migrations inside Docker...
docker compose --profile tools run --rm migrate

echo.
echo [5/5] Launching background workers (Hold Reaper, Outbox Projector, Saga Reconciler)...
docker compose --profile workers up -d workers

echo.
echo =====================================================================
echo  Stack is UP and healthy!
echo    - Frontend UI:             http://localhost:8080 or http://localhost
echo    - Control Room & Test Lab: http://localhost:8080/admin/lab
echo    - API Endpoint:            http://localhost:3000/api
echo    - Citus Coordinator DB:    localhost:54320 (airline / airline)
echo    - PgBouncer Pool:          localhost:6432 (airline / airline)
echo    - Read-Model DB:           localhost:5433 (airline / airline)
echo =====================================================================
echo.
pause
