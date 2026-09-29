@echo off
rem Agent 控制台 · 一键启动（起本地服务并打开浏览器）
setlocal
set HERE=%~dp0
start "" /min cmd /c "node "%HERE%server.mjs" 3082"
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:3082"
endlocal
