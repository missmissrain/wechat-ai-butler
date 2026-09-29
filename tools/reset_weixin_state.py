"""清理链路的调试数据（会话路由 / 投递 / 发送队列），可选保留长期记忆。

用途：反复联调之后，队列和路由里会堆一批测试残留。这个脚本把它们清掉，
免得"上一轮的积压"干扰下一轮判断。

**默认不动长期记忆**（时间线、知识图谱）——那是真实回忆，不该因为调试被删；
要一起清请显式加 `--purge-memory`。

用法：
    python tools/reset_weixin_state.py                # 只清队列/路由/投递
    python tools/reset_weixin_state.py --purge-memory  # 连时间线与图谱一起清
    python tools/reset_weixin_state.py --dry-run       # 只看会删什么
"""

from __future__ import annotations

import argparse
import os
import shutil
import sqlite3
import sys
from pathlib import Path

DSH_HOME = Path(os.environ.get("DSH_HOME") or (Path.home() / ".dsh"))
STATE_DB = DSH_HOME / "weixin-state.db"
MEMORY_DIRS = [DSH_HOME / "timeline", DSH_HOME / "graph"]


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="清空微信链路的调试数据")
    parser.add_argument("--purge-memory", action="store_true",
                        help="连长期记忆（时间线 + 知识图谱）一起清掉")
    parser.add_argument("--dry-run", action="store_true", help="只显示会删什么")
    options = parser.parse_args(argv)

    if not STATE_DB.is_file():
        print("状态库不存在：%s" % STATE_DB)
    else:
        connection = sqlite3.connect(STATE_DB)
        print("当前：")
        for table in ("outbox", "delivery", "route", "turn_context"):
            count = connection.execute("SELECT COUNT(*) FROM %s" % table).fetchone()[0]
            print("  %-14s %d 行" % (table, count))
        if options.dry_run:
            print("\n（--dry-run，不实际删除）")
        else:
            connection.execute("DELETE FROM outbox")
            connection.execute("DELETE FROM delivery")
            connection.execute("DELETE FROM turn_context")
            connection.execute("DELETE FROM route")
            connection.execute("DELETE FROM transport_cursor")
            connection.commit()
            print("\n已清空 outbox / delivery / turn_context / route / 游标")
        connection.close()

    if options.purge_memory:
        for directory in MEMORY_DIRS:
            if not directory.is_dir():
                continue
            if options.dry_run:
                print("会删除长期记忆目录：%s" % directory)
            else:
                shutil.rmtree(directory, ignore_errors=True)
                print("已删除长期记忆目录：%s" % directory)
    else:
        print("\n长期记忆（时间线/知识图谱）未改动；要一起清加 --purge-memory")

    print("\n提示：状态库清空后建议重启链路（start_stack.py）。")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
