@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title Auto-Editor GUI V6 Launcher

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js was not found.
  echo Install Node.js and run this file again.
  echo.
  pause
  exit /b 1
)

echo.
echo [1/3] Cleaning old Auto-Editor GUI instances and temp previews...
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0cleanup-old-instances.ps1"
if errorlevel 1 (
  echo Cleanup failed. The GUI was NOT started.
  pause
  exit /b 1
)

echo [2/3] Starting V6 backend...
del /q "%~dp0server.log" >nul 2>nul
start "Auto-Editor GUI V6 Server" /min cmd.exe /d /c "cd /d ""%~dp0"" && node ""%~dp0server.js"" 1>>server.log 2>>&1"

echo [3/3] Waiting for health check...
set "READY="
for /L %%I in (1,1,35) do (
  powershell.exe -NoLogo -NoProfile -Command "$ErrorActionPreference='Stop'; $h=Invoke-RestMethod -Uri 'http://127.0.0.1:37906/api/health' -TimeoutSec 1; if($h.ok -and $h.app -eq 'auto-editor-gui' -and $h.version -eq '6'){exit 0}else{exit 1}" >nul 2>nul
  if not errorlevel 1 (
    set "READY=1"
    goto READY
  )
  >nul 2>nul ping 127.0.0.1 -n 2
)

echo.
echo Auto-Editor GUI backend did not become ready.
echo Check server.log in this folder.
if exist "%~dp0server.log" type "%~dp0server.log"
pause
exit /b 1

:READY
echo Ready. Opening GUI...
start "" "http://127.0.0.1:37906"
exit /b 0
