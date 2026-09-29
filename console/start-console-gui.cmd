@echo off
rem Agent 控制台 · 桌面版（Electron 壳）
rem 右上角叉叉 = 最小化到托盘；右击托盘图标 = 可退出
setlocal
set HERE=%~dp0
if not exist "%HERE%node_modules\electron\dist\electron.exe" (
  echo [错误] 还没安装 Electron，请先在 console 目录执行：npm install
  pause
  exit /b 1
)
start "" "%HERE%node_modules\electron\dist\electron.exe" "%HERE%"
endlocal
