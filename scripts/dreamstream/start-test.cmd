@echo off
set "PATH=%ProgramFiles%\nodejs;%ProgramFiles%\Git\cmd;%PATH%"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-test.ps1"
if errorlevel 1 (
  echo.
  pause
)
