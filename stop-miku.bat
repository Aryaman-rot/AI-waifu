@echo off
REM Stop the AI companion: the face and the brain.
REM ExecutionPolicy Bypass is scoped to this one invocation only.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-miku.ps1"
if errorlevel 1 (
    echo.
    echo Stop failed. The error is above.
    pause
)
