@echo off
title AeroScale Cluster Oversell Audit
color 0B
cd /d "%~dp0"
echo ==============================================================================================
echo                 AEROSCALE DISTRIBUTED INVENTORY - LIVE OVERSELL AUDIT
echo ==============================================================================================
echo Scanning Citus distributed coordinator (port 55432) and flight inventory tables...
echo.
node scripts\oversell-audit.js %*
echo.
echo ==============================================================================================
echo Audit execution completed.
echo Press any key to close this window...
pause >nul
exit
