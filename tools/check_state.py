"""查看链路状态：发送队列、投递、租约、时间线/图谱规模。

只读，不改任何数据。排查"消息发不出去/卡住"时先跑这个。

用法：
    python tools/check_state.py
"""

from __future__ import annotations

import json
import os
import sqlite3
import sys
import time
from pathlib import Path

DSH_HOME = Path(os.environ.get("DSH_HOME") or (Path.home() / ".dsh"))
STATE_DB = DSH_HOME / "weixin-state.db"


def human_time(ms: int | None) -> str:
    return "—" if not ms else time.strftime("%m-%d %H:%M:%S", time.localtime(ms / 1000))


def main() -> int:
    if not STATE_DB.is_file():
        print("状态库不存在：%s" % STATE_DB)
        print("链路还没启动过？")
        return 1

    connection = sqlite3.connect(STATE_DB)
    connection.row_factory = sqlite3.Row

    print("状态库：%s" % STATE_DB)
    schema_row = connection.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()
    print("schema 版本：%s" % (schema_row["value"] if schema_row is not None else "?"))

    print("\n=== 发送队列 ===")
    rows = list(connection.execute(
        "SELECT status, kind, COUNT(*) AS n FROM outbox GROUP BY status, kind ORDER BY status"))
    for row in rows:
        print("  %-18s %-10s %d" % (row["status"], row["kind"], row["n"]))
    if not rows:
        print("  （空）")

    print("\n=== 待发送明细（最多 10 条）===")
    for row in connection.execute(
        "SELECT sequence, status, kind, turn, attempt, last_error, substr(text,1,60) AS text "
        "FROM outbox WHERE status <> 'sent' ORDER BY sequence DESC LIMIT 10"
    ):
        print("  seq=%-4s %-16s turn=%-5s attempt=%-2s %s" % (
            row["sequence"], row["status"], row["turn"], row["attempt"],
            (row["text"] or "").replace("\n", " ")[:50]))
        if row["last_error"]:
            print("       err: %s" % row["last_error"][:110])

    print("\n=== 投递 ===")
    for row in connection.execute(
        "SELECT status, COUNT(*) AS n FROM delivery GROUP BY status ORDER BY n DESC"):
        print("  %-18s %d" % (row["status"], row["n"]))
    latest = connection.execute(
        "SELECT delivery_id, status, received_at FROM delivery ORDER BY received_at DESC LIMIT 1").fetchone()
    if latest is not None:
        print("  最近一条：%s %s %s" % (latest["delivery_id"], latest["status"], human_time(latest["received_at"])))

    print("\n=== 租约（谁在消费）===")
    lease = connection.execute("SELECT * FROM consumer_lease").fetchone()
    if lease is None:
        print("  （没有租约，说明链路没在跑）")
    else:
        alive = False
        try:
            os.kill(lease["pid"], 0)
            alive = True
        except OSError as error:
            alive = getattr(error, "errno", None) == 13  # EPERM = 存在但没权限
        print("  owner=%s pid=%s 存活=%s 心跳=%s" % (
            lease["owner_id"], lease["pid"], alive, human_time(lease["heartbeat_at"])))
    connection.close()

    print("\n=== 长期记忆 ===")
    timeline = DSH_HOME / "timeline" / "index.json"
    if timeline.is_file():
        try:
            data = json.loads(timeline.read_text(encoding="utf-8"))
            days = sorted(data.get("days", {}))
            total = sum(meta.get("entries", 0) for meta in data.get("days", {}).values())
            print("  时间线：%d 天 / %d 条记录（最近 %s）" % (len(days), total, days[-1] if days else "—"))
        except json.JSONDecodeError:
            print("  时间线索引损坏（下次读取会自动从 days/*.jsonl 重建）")
    else:
        print("  时间线：还没有数据")
    graph = DSH_HOME / "graph"
    if (graph / "nodes.jsonl").is_file():
        people = sum(1 for line in (graph / "nodes.jsonl").read_text(encoding="utf-8").splitlines() if line.strip())
        edges = sum(1 for line in (graph / "edges.jsonl").read_text(encoding="utf-8").splitlines()
                    if line.strip()) if (graph / "edges.jsonl").is_file() else 0
        print("  知识图谱：%d 人 / %d 条称呼" % (people, edges))
    else:
        print("  知识图谱：还没有数据")
    return 0


if __name__ == "__main__":
    sys.exit(main())
