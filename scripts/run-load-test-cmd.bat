@echo off
title AeroScale 1,000,000 Req/Sec Load Testing Monitor
color 0A
cd /d "%~dp0\.."
node scripts\run-cmd-suite.js LOAD_TEST_BURST
exit
