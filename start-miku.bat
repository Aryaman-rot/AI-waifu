@echo off
REM Double-click launcher for the AI companion.
REM ExecutionPolicy Bypass is scoped to this one invocation: it lets the
REM script run under the default Windows policy without changing the machine
REM or the user's settings, and without needing an admin prompt.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-miku.ps1"
if errorlevel 1 (
    echo.
    echo Startup failed. The error is above.
    pause
)
