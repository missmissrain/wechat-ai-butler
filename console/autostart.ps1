# Agent 控制台 · 开机自启管理
#
# 做法：在当前用户的"启动"文件夹放一个快捷方式，直接指向 electron.exe。
# 为什么不放 .cmd：.cmd 启动会闪一个黑窗口，用户明确说过容易误关；
# electron.exe 是 GUI 程序，本身没有控制台窗口，最干净。
#
# 用法：
#   powershell -File autostart.ps1          安装
#   powershell -File autostart.ps1 remove   取消
#   powershell -File autostart.ps1 status   查看当前状态

param([string]$Action = "install")

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$electron = Join-Path $here "node_modules\electron\dist\electron.exe"
$startup = [Environment]::GetFolderPath("Startup")
$shortcutPath = Join-Path $startup "Agent 控制台.lnk"

function Show-Status {
    if (Test-Path $shortcutPath) {
        $shell = New-Object -ComObject WScript.Shell
        $link = $shell.CreateShortcut($shortcutPath)
        Write-Host "状态：已设置开机自启"
        Write-Host "  快捷方式：$shortcutPath"
        Write-Host "  目标：$($link.TargetPath)"
        Write-Host "  参数：$($link.Arguments)"
        Write-Host "  工作目录：$($link.WorkingDirectory)"
        $targetExists = Test-Path $link.TargetPath
        Write-Host "  目标是否存在：$targetExists"
    }
    else {
        Write-Host "状态：未设置开机自启（$shortcutPath 不存在）"
    }
}

switch ($Action) {
    "install" {
        if (-not (Test-Path $electron)) {
            Write-Host "[错误] 找不到 Electron：$electron"
            Write-Host "请先在 console 目录执行：npm install"
            exit 1
        }
        $shell = New-Object -ComObject WScript.Shell
        $link = $shell.CreateShortcut($shortcutPath)
        $link.TargetPath = $electron
        # 参数：把 console 目录作为"应用目录"传进去，并带 --hidden（开机静默驻留托盘）
        $link.Arguments = "`"$here`" --hidden"
        $link.WorkingDirectory = $here
        $link.IconLocation = "$electron,0"
        $link.Description = "Agent 控制台（开机静默驻留托盘；右击托盘图标可退出）"
        $link.Save()
        Write-Host "已设置开机自启："
        Show-Status
    }
    "remove" {
        if (Test-Path $shortcutPath) {
            Remove-Item $shortcutPath -Force
            Write-Host "已取消开机自启（删除了 $shortcutPath）"
        }
        else {
            Write-Host "本来就没有设置，无需取消"
        }
    }
    "status" { Show-Status }
    default { Write-Host "未知动作：$Action（可用：install / remove / status）" }
}
