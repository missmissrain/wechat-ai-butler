"""模型切换器：读写 config/modelConfig.json 的 defaultModel，并可直接重启微信链路。

用法：
    python switch_model.py                      # 列出所有 provider/模型与当前默认
    python switch_model.py <provider> <model>   # 切换默认模型（改完需重启才生效）
    python switch_model.py <provider> <model> --restart
    python switch_model.py --restart            # 仅重启

模型/key/地址的唯一来源是 config/modelConfig.json；本脚本只改 defaultModel 字段。
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent
CONFIG_JSON = PROJECT_ROOT / "config" / "modelConfig.json"

# 结束在跑的 harness 用的进程匹配（与 start_stack / 控制台同一套判定）。
HARNESS_PROCESS_PATTERN = "apps/cli/src/bin.ts|pnpm.*dsh|startHarnessBackend"


def load() -> dict:
    """读取模型配置 JSON。"""
    return json.loads(CONFIG_JSON.read_text(encoding="utf-8"))


def show(config: dict) -> None:
    """打印全部 provider 与模型，并标出当前默认。"""
    default = config.get("defaultModel", {})
    print("当前默认：%s / %s" % (default.get("provider"), default.get("model")))
    for pid, spec in config.get("providers", {}).items():
        mark = " <== 默认" if pid == default.get("provider") else ""
        print("\n[%s] %s%s" % (pid, spec.get("displayName", ""), mark))
        print("    api=%s  baseURL=%s" % (spec.get("api"), spec.get("baseURL")))
        print("    key=%s… (env %s)" % (str(spec.get("apiKey"))[:10], spec.get("apiKeyEnv")))
        for model in spec.get("models", []):
            star = " *" if model.get("id") == default.get("model") else "  "
            note = (" — " + model["note"]) if model.get("note") else ""
            print("    %s %s%s" % (star, model.get("id"), note))


def switch(provider: str, model: str) -> int:
    """把 defaultModel 切到指定 provider/model，写前备份。"""
    config = load()
    providers = config.get("providers", {})
    if provider not in providers:
        print("未知 provider：%s；可选：%s" % (provider, ", ".join(providers)))
        return 1
    known = [m.get("id") for m in providers[provider].get("models", [])]
    if model not in known:
        print("provider %s 下没有模型 %s；可选：%s" % (provider, model, ", ".join(known)))
        return 1
    backup = CONFIG_JSON.with_name("modelConfig.json.bak-" + time.strftime("%Y%m%d-%H%M%S"))
    backup.write_text(CONFIG_JSON.read_text(encoding="utf-8"), encoding="utf-8")
    config["defaultModel"] = {"provider": provider, "model": model}
    CONFIG_JSON.write_text(json.dumps(config, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("已切换默认模型 → %s / %s" % (provider, model))
    print("备份：%s" % backup.name)
    return 0


def kill_harness() -> None:
    """结束在跑的 harness 进程。

    统一走项目内的 `tools/stop_stack.py`：以前这里指向系统临时目录里的一个脚本，
    等于把本机路径写进项目、还依赖一个随时可能被清理的文件。
    """
    stop_script = PROJECT_ROOT / "tools" / "stop_stack.py"
    if stop_script.is_file():
        subprocess.run([sys.executable, str(stop_script)], cwd=str(PROJECT_ROOT), check=False)
        return
    # 极端兜底：tools 被删了也要能停（不依赖任何外部文件）
    if os.name != "nt":
        subprocess.run(["pkill", "-f", HARNESS_PROCESS_PATTERN], check=False)
    else:
        script = (
            "$ErrorActionPreference='SilentlyContinue';"
            "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match '%s' } |"
            " ForEach-Object { Stop-Process -Id $_.ProcessId -Force }" % HARNESS_PROCESS_PATTERN
        )
        subprocess.run(["powershell.exe", "-NoLogo", "-NoProfile", "-Command", script], check=False)
    time.sleep(3)


def restart() -> int:
    """杀掉当前 harness，再启动（会自动同步 settings.yaml）。"""
    kill_harness()
    return subprocess.run([sys.executable, str(PROJECT_ROOT / "start_stack.py")], cwd=str(PROJECT_ROOT)).returncode


def main(argv: list[str]) -> int:
    """按命令行参数列出或切换模型。"""
    args = [a for a in argv if a != "--restart"]
    wants_restart = "--restart" in argv
    if not args:
        show(load())
        return restart() if wants_restart else 0
    if len(args) != 2:
        print(__doc__)
        return 1
    code = switch(args[0], args[1])
    if code != 0:
        return code
    return restart() if wants_restart else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
