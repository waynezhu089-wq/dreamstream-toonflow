@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-test.ps1"
if errorlevel 1 (
  echo.
  pause
)
