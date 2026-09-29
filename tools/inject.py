"""向本机调试注入口发一条消息（开发/回归用，不需要真手机发微信）。

前置：链路启动时设置 `DSH_WEIXIN_INJECT_PORT`（默认 3081）。
消息会**走完整入站管线**：delivery 登记 → 协调器 → agent → outbox → 微信。

用法：
    python tools/inject.py "10分钟后提醒我：检查备份"
    python tools/inject.py --port 3081 "你好"
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.request


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="向欣爱的调试注入口发送一条测试消息")
    parser.add_argument("text", help="要注入的消息正文")
    parser.add_argument("--port", type=int, default=3081, help="注入口端口，默认 3081")
    parser.add_argument("--user", help="指定收件人 user_id；默认用最近一次入站的用户")
    options = parser.parse_args(argv)

    body = {"text": options.text}
    if options.user:
        body["user_id"] = options.user
    request = urllib.request.Request(
        "http://127.0.0.1:%d/inject" % options.port,
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            print("inject ->", response.read().decode("utf-8")[:300])
    except Exception as error:  # 注入口没开时给一句人话
        print("注入失败：%r" % (error,))
        print("提示：确认链路在跑，且设置了 DSH_WEIXIN_INJECT_PORT（默认 3081）。")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
