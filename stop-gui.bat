@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title Auto-Editor GUI V6 Stop
echo Stopping Auto-Editor GUI and cleaning temporary state...
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0cleanup-old-instances.ps1"
echo Done.
timeout /t 1 /nobreak >nul
exit /b 0
