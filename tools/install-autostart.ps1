# 注册/注销"欣爱（微信后端）"的开机自启。
#
# 用启动文件夹的快捷方式，而不是计划任务：**不需要管理员权限**，
# 和控制台自启（Agent 控制台.lnk）保持同一套做法。
# 延迟启动的逻辑放在 tools\autostart.py 里（等网络/代理就绪），所以这里只是放个快捷方式。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File tools\install-autostart.ps1            # 注册
#   powershell -ExecutionPolicy Bypass -File tools\install-autostart.ps1 -Remove    # 注销
#   powershell -ExecutionPolicy Bypass -File tools\install-autostart.ps1 -Status    # 查看

param(
    [switch]$Remove,
    [switch]$Status
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$startupDir = [Environment]::GetFolderPath('Startup')
$shortcutPath = Join-Path $startupDir '欣爱（微信后端）.lnk'
$pythonw = 'D:\py39\pythonw.exe'
$entry = Join-Path $projectRoot 'tools\autostart.py'

function Show-Status {
    Write-Host "启动文件夹: $startupDir"
    Write-Host "快捷方式:   $shortcutPath"
    if (Test-Path -LiteralPath $shortcutPath) {
        $shell = New-Object -ComObject WScript.Shell
        $link = $shell.CreateShortcut($shortcutPath)
        Write-Host "状态:       已注册"
        Write-Host "  目标:     $($link.TargetPath)"
        Write-Host "  参数:     $($link.Arguments)"
        Write-Host "  工作目录: $($link.WorkingDirectory)"
    } else {
        Write-Host "状态:       未注册"
    }
    Write-Host "pythonw 存在: $(Test-Path -LiteralPath $pythonw)"
    Write-Host "自启入口存在: $(Test-Path -LiteralPath $entry)"
}

if ($Status) {
    Show-Status
    exit 0
}

if ($Remove) {
    if (Test-Path -LiteralPath $shortcutPath) {
        Remove-Item -LiteralPath $shortcutPath -Force
        Write-Host "已注销开机自启：$shortcutPath"
    } else {
        Write-Host "本来就没有注册"
    }
    exit 0
}

if (-not (Test-Path -LiteralPath $pythonw)) {
    throw "找不到 pythonw.exe：$pythonw（自启需要它来避免黑框）"
}
if (-not (Test-Path -LiteralPath $entry)) {
    throw "找不到自启入口：$entry"
}

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $pythonw
$shortcut.Arguments = '"' + $entry + '"'
$shortcut.WorkingDirectory = $projectRoot
$shortcut.Description = '开机自启：拉起微信 harness 后端（欣爱）'
$shortcut.WindowStyle = 7          # 最小化，pythonw 本就不弹窗，双保险
$shortcut.Save()

Write-Host "已注册开机自启：$shortcutPath"
Show-Status
