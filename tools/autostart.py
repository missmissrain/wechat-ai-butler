"""开机自启入口：把 harness（欣爱）拉起来。

为什么不直接在启动文件夹里放 start_stack.py：

1. **开机时网络/代理还没起**。启动器会探测本地代理（Clash 127.0.0.1:7897），
   也做微信 token 探活；太早跑会拿到"代理未就绪/token 失效"的错误结论。
   所以这里先等一会儿（默认 45 秒，`--delay` 可改），再调用真正的启动器。
2. **pythonw 没有控制台**。自启不能弹黑框，而 pythonw 下 `print` 无处可去；
   这里把 stdout/stderr 重定向到 `runtime/autostart.log`，出问题能查。
3. **幂等**。已经在跑就什么都不做——开机时手动点过一次、或控制台已经拉起过，
   都不该再拉出第二套。

用法：
    pythonw tools\\autostart.py                 # 自启（等 45 秒后拉起）
    pythonw tools\\autostart.py --delay 90      # 自定义等待
    python tools\\autostart.py --check          # 只体检：报告状态、不启动任何东西
"""

from __future__ import annotations

import argparse
import runpy
import socket
import sys
import time
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
START_STACK = PROJECT_ROOT / "start_stack.py"
LOG_PATH = PROJECT_ROOT / "runtime" / "autostart.log"
HARNESS_PORT = int(__import__("os").environ.get("DSH_HARNESS_PORT") or "3080")


def port_open(port: int, host: str = "127.0.0.1", timeout: float = 1.5) -> bool:
    """端口上有东西在监听（用来判断"是不是已经在跑"）。"""
    with socket.socket() as probe:
        probe.settimeout(timeout)
        return probe.connect_ex((host, port)) == 0


_LOG_HANDLE = None


def log(message: str) -> None:
    """写一行带时间的日志；前台运行时也打到控制台。

    注意：`redirect_output()` 会把 stdout 指向同一个日志文件，所以这里**不能无条件 print**，
    否则每一行都会写两遍（实测日志里每行都重复）。只在 stdout 不是那个句柄时才 print。
    """
    line = f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {message}"
    try:
        if sys.stdout is not _LOG_HANDLE:
            print(line, flush=True)
    except Exception:
        pass
    try:
        LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        with LOG_PATH.open("a", encoding="utf-8") as handle:
            handle.write(line + "\n")
    except Exception:
        pass


def redirect_output() -> None:
    """把 stdout/stderr 接到日志文件（pythonw 下没有控制台）。"""
    global _LOG_HANDLE
    try:
        LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        handle = LOG_PATH.open("a", encoding="utf-8", buffering=1)
        _LOG_HANDLE = handle
        sys.stdout = handle
        sys.stderr = handle
    except Exception:
        pass


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="开机自启入口：拉起微信 harness 后端")
    parser.add_argument("--delay", type=int, default=45, help="启动前等待秒数（给网络/代理留时间）")
    parser.add_argument("--check", action="store_true", help="只体检：报告状态，不启动任何东西")
    args = parser.parse_args(argv)

    if args.check:
        print("项目目录:", PROJECT_ROOT)
        print("启动器存在:", START_STACK.is_file())
        print(f"harness 端口 {HARNESS_PORT} 已在监听:", port_open(HARNESS_PORT))
        print("日志文件:", LOG_PATH)
        print("（--check 不启动任何东西）")
        return 0

    redirect_output()
    log("=" * 60)
    log(f"自启触发（delay={args.delay}s）")

    if not START_STACK.is_file():
        log(f"找不到启动器：{START_STACK}")
        return 1

    if args.delay > 0:
        log(f"先等 {args.delay} 秒，让网络/代理就绪…")
        time.sleep(args.delay)

    if port_open(HARNESS_PORT):
        log(f"harness 已经在跑（端口 {HARNESS_PORT} 在监听），不重复拉起")
        return 0

    log("开始运行 start_stack.py")
    try:
        runpy.run_path(str(START_STACK), run_name="__main__")
    except SystemExit as exit_signal:
        log(f"启动器退出（code={exit_signal.code}）")
        return int(exit_signal.code or 0)
    except Exception as error:  # noqa: BLE001 - 自启场景下必须留下痕迹而不是静默死掉
        log(f"启动失败：{type(error).__name__}: {error}")
        return 1
    log("启动器执行完毕")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
