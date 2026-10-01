@echo off
set "PATH=%ProgramFiles%\nodejs;%ProgramFiles%\Git\cmd;%PATH%"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0prepare-test.ps1"
echo.
pause
