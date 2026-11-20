@echo off
setlocal

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0flash.ps1"
set "EXIT_CODE=%ERRORLEVEL%"

echo.
if not "%EXIT_CODE%"=="0" (
    echo Flashing failed. Review the error above.
) else (
    echo Flashing finished. You can close this window.
)

pause
exit /b %EXIT_CODE%
