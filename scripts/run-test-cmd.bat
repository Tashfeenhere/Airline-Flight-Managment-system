@echo off
title AeroScale Distributed Cluster - Live Test Console
color 0B
cd /d "%~dp0\.."
node scripts\run-cmd-suite.js %*
exit
