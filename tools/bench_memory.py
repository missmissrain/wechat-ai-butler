"""时间线写入性能基准（回归用）。

背景：审计测到 1000 条 append 要 72 秒（每次 append 都读全文+重写 JSONL+重建索引+重建 Markdown）。
修复后（追加写 + 索引增量 + 视图惰性重建）应显著下降。**写入路径变慢会直接拖住微信主链路**，
所以这个数值应当长期盯着。

用法：
    python tools/bench_memory.py
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import time
from pathlib import Path

HARNESS = Path(__file__).resolve().parent.parent.parent / "deepseek-harness"
STORE = HARNESS / "packages" / "webhook" / "webhook-weixin" / "src" / "memory" / "timelineStore.ts"

RUNNER = r"""
import { TimelineStore } from '%(store)s'
const dir = process.argv[2]
const count = Number(process.argv[3])
const store = new TimelineStore({ dir, timezone: 'Asia/Shanghai' })
const base = Date.parse('2026-01-01T02:00:00Z')
const durations = []
const started = Date.now()
for (let index = 0; index < count; index += 1) {
  const t0 = Date.now()
  store.append({
    id: 'e' + index, ts: base + index * 1000,
    role: index %% 2 === 0 ? 'user' : 'assistant',
    text: '第' + index + '条消息，用来测量写入耗时。',
  })
  durations.push(Date.now() - t0)
}
durations.sort((a, b) => a - b)
console.log(JSON.stringify({
  count, total_ms: Date.now() - started,
  p95_ms: durations[Math.floor(durations.length * 0.95)] ?? 0,
  max_ms: durations[durations.length - 1] ?? 0,
}))
"""


def main() -> int:
    if not STORE.is_file():
        print("找不到 timelineStore.ts：%s" % STORE)
        print("（本脚本假设它和 deepseek-harness 是同级目录）")
        return 1

    runner = Path(tempfile.gettempdir()) / "xinai-bench-timeline.mts"
    runner.write_text(RUNNER % {"store": str(STORE).replace("\\", "/")}, encoding="utf-8")

    print("条数   总计ms   单条p95   最后一条")
    for count in (100, 500, 1000):
        workdir = Path(tempfile.mkdtemp(prefix="xinai-bench-"))
        try:
            import subprocess
            output = subprocess.run(
                ["node", "--import", "tsx/esm", str(runner), str(workdir), str(count)],
                cwd=str(HARNESS), capture_output=True, text=True, timeout=600,
            )
            line = [item for item in output.stdout.splitlines() if item.startswith("{")]
            if not line:
                print("%5d  失败：%s" % (count, (output.stderr or output.stdout)[-200:]))
                continue
            data = json.loads(line[-1])
            print("%5d   %6d     %5.1f      %5.0f" % (
                data["count"], data["total_ms"], data["p95_ms"], data["max_ms"]))
        finally:
            shutil.rmtree(workdir, ignore_errors=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
