@echo off
title AeroScale Distributed Backend API (Port 3001)
color 0A
cd /d "%~dp0"
echo ==============================================================================================
echo                 AEROSCALE DISTRIBUTED INVENTORY - LIVE BACKEND SERVER
echo ==============================================================================================
echo Listening on: http://127.0.0.1:3001
echo Coordinator : 127.0.0.1:55432
echo Read Replica: 127.0.0.1:5433
echo.
node src\server.js
pause
