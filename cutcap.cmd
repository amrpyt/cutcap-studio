@echo off
setlocal EnableExtensions
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required.
  exit /b 1
)

if not exist "%APPDATA%\npm\node_modules\capcut-cli\dist\index.js" (
  echo Installing capcut-cli 0.26.0 once...
  call npm install -g capcut-cli@0.26.0
  if errorlevel 1 exit /b 1
)

node "%~dp0quick-capcut.js" %*
exit /b %errorlevel%
