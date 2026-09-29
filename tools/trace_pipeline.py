"""追踪一条消息的完整链路（从探针日志里把同一 delivery 的事件串起来）。

排查"用户发了消息但没回复/回复没发出"时，比来回翻日志快得多。

用法：
    python tools/trace_pipeline.py                  # 最近一条入站消息
    python tools/trace_pipeline.py <delivery_id>    # 指定一条
    python tools/trace_pipeline.py --tail 2000      # 只看日志末尾 N 行
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

PROJECT = Path(__file__).resolve().parent.parent
PROBE_LOG = PROJECT / "runtime" / "weixin-probe.log"

# 一条消息会经过的阶段（按此顺序展示，便于一眼看出卡在哪）
STAGES = [
    ("ingress", "poll.messages", "① 收到消息"),
    ("state", "delivery.received", "② 登记投递"),
    ("state", "delivery.status", "③ 状态流转"),
    ("inbound", "message.inject", "④ 注入 agent"),
    ("outbound", "turn.start", "⑤ 回合开始"),
    ("state", "outbox.enqueued", "⑥ 回复入队"),
    ("outbound", "send.attempt", "⑦ 尝试发送"),
    ("outbound", "send.rejected", "✗ 被服务端拒绝"),
    ("outbound", "outbox.sent", "✓ 发送成功"),
    ("outbound", "send.gave_up", "✗ 放弃"),
    ("outbound", "drain.paused", "⏸ 整体冷却中"),
]


def load_events(limit: int) -> list[dict]:
    if not PROBE_LOG.is_file():
        return []
    lines = PROBE_LOG.read_text(encoding="utf-8", errors="replace").splitlines()
    events: list[dict] = []
    for line in lines[-limit:]:
        line = line.strip()
        if not line:
            continue
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return events


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="追踪一条消息的完整链路")
    parser.add_argument("delivery_id", nargs="?", help="投递 id；默认取最近一条")
    parser.add_argument("--tail", type=int, default=4000, help="只扫描日志末尾 N 行，默认 4000")
    options = parser.parse_args(argv)

    events = load_events(options.tail)
    if not events:
        print("读不到探针日志：%s" % PROBE_LOG)
        return 1

    target = options.delivery_id
    if target is None:
        for event in reversed(events):
            data = event.get("data", {})
            if event.get("event") == "delivery.received":
                target = data.get("delivery_id")
                break
    if target is None:
        print("日志里没有找到任何投递记录")
        return 1

    print("追踪 delivery_id = %s\n" % target)
    found = False
    for event in events:
        blob = json.dumps(event.get("data", {}), ensure_ascii=False)
        if target not in blob:
            continue
        for scope, name, label in STAGES:
            if event.get("scope") == scope and event.get("event") == name:
                detail = blob
                if len(detail) > 160:
                    detail = detail[:160] + "…"
                print("  %s  %s  %s" % (event.get("at", "")[11:19], label, detail))
                found = True
                break
    if not found:
        print("  没找到这条投递的事件（可能已被日志轮转；试试 --tail 更大的值）")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
