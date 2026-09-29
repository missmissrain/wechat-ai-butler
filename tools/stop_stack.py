"""停止欣爱（harness）后台进程。

用途：`switch_model.py`、控制台和人工维护都用它，避免"停服务"的逻辑散落在多份脚本里
（历史上就散过：一个放在系统临时目录的脚本被外部依赖着）。

用法：
    python tools/stop_stack.py
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
import time

# 判定"这是 harness 进程"的命令行特征（与 start_stack/控制台保持一致）
HARNESS_PATTERN = re.compile(r"apps/cli/src/bin\.ts|pnpm[^\s]*\"?\s*dsh|startHarnessBackend", re.I)


def list_processes() -> list[dict]:
    """列出进程（Windows 走 PowerShell，其它平台走 ps）。"""
    if os.name != "nt":
        out = subprocess.run(["ps", "-eo", "pid=,args="], capture_output=True, text=True).stdout
        return [{"ProcessId": int(line.split(None, 1)[0]), "CommandLine": line.split(None, 1)[1]}
                for line in out.splitlines() if len(line.split(None, 1)) == 2]
    import json
    out = subprocess.run(
        ["powershell.exe", "-NoLogo", "-NoProfile", "-Command",
         "Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"],
        capture_output=True, text=True, timeout=60,
    ).stdout
    data = json.loads(out or "[]")
    return data if isinstance(data, list) else [data]


def kill_harness() -> list[int]:
    """结束 harness 进程，返回被结束的 pid 列表。"""
    me = os.getpid()
    killed: list[int] = []
    for proc in list_processes():
        pid = proc.get("ProcessId")
        cmd = proc.get("CommandLine") or ""
        if pid is None or pid == me or not HARNESS_PATTERN.search(cmd):
            continue
        command = ["taskkill", "/F", "/T", "/PID", str(pid)] if os.name == "nt" else ["kill", "-9", str(pid)]
        subprocess.run(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
        killed.append(pid)
    return killed


def port_free(port: int) -> bool:
    """端口是否已释放。"""
    import socket
    sock = socket.socket()
    sock.settimeout(1.0)
    try:
        sock.connect(("127.0.0.1", port))
        return False
    except OSError:
        return True
    finally:
        sock.close()


def main() -> int:
    killed = kill_harness()
    print("killed=%s" % killed)
    time.sleep(3)
    print("port3080=%s" % ("free" if port_free(3080) else "still_listening"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
