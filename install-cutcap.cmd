@echo off
setlocal EnableExtensions
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required before installing cutcap.
  pause
  exit /b 1
)

call npm install -g capcut-cli@0.26.0
if errorlevel 1 exit /b 1

if not exist "%APPDATA%\npm" mkdir "%APPDATA%\npm"
>"%APPDATA%\npm\cutcap.cmd" echo @echo off
>>"%APPDATA%\npm\cutcap.cmd" echo call "%~dp0cutcap.cmd" %%*

echo.
echo Installed. Use from any terminal:
echo cutcap "D:\video.mp4"
echo.
pause
