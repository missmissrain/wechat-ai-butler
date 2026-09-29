@echo off
rem Xinai Console - enable/disable autostart (adds a shortcut to the user's Startup folder)
rem Usage: install-autostart.cmd           -> enable (starts hidden in tray at login)
rem        install-autostart.cmd remove    -> disable
rem        install-autostart.cmd status    -> show current state
setlocal
set HERE=%~dp0
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%HERE%autostart.ps1" %1
echo.
pause
endlocal
